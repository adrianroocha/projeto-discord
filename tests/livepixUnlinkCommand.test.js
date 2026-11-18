jest.mock('../src/database/livepixAccountsRepository', () => ({
  findByDiscordId: jest.fn(),
  unlinkWithAudit: jest.fn(),
}));
jest.mock('../src/database/kickAccountsRepository', () => ({
  findByDiscordId: jest.fn(),
  unlinkWithAudit: jest.fn(),
}));
jest.mock('../src/services/accountUnlinkConfirmationService', () => ({
  cleanupExpired: jest.fn(),
  create: jest.fn(),
  validate: jest.fn(),
  consume: jest.fn(),
  invalidate: jest.fn(),
}));

const {
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const livepixAccountsRepository = require('../src/database/livepixAccountsRepository');
const kickAccountsRepository = require('../src/database/kickAccountsRepository');
const confirmationService = require('../src/services/accountUnlinkConfirmationService');
const command = require('../src/commands/livepixUnlink');
const confirmButton = require('../src/buttons/livepixUnlinkConfirm');
const cancelButton = require('../src/buttons/livepixUnlinkCancel');

function makePermissions(isAdmin) {
  return { has: (flag) => isAdmin && flag === PermissionFlagsBits.Administrator };
}

describe('/livepix-unlink command and confirmation buttons', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    confirmationService.create.mockReturnValue({
      token: 'livepix-token',
      expiresAtMs: 1_700_000_300_000,
    });
  });

  test('somente Administrator pode iniciar a desvinculação', async () => {
    const interaction = {
      inGuild: () => true,
      memberPermissions: makePermissions(false),
      user: { id: 'user-1' },
      options: {
        getUser: jest.fn(),
        getString: jest.fn(),
      },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect(livepixAccountsRepository.findByDiscordId).not.toHaveBeenCalled();
    expect(livepixAccountsRepository.unlinkWithAudit).not.toHaveBeenCalled();
  });

  test('opções obrigatórias e confirmação temporária ficam registradas no nome compartilhado', async () => {
    const json = command.data.toJSON();
    expect(json.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
    expect(json.options.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'usuario', required: true },
      { name: 'motivo', required: true },
    ]);

    livepixAccountsRepository.findByDiscordId.mockReturnValue({
      livepix_account_id: 'livepix-account-1',
    });
    const interaction = {
      inGuild: () => true,
      memberPermissions: makePermissions(true),
      user: { id: 'admin-1' },
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'discord-target' }),
        getString: jest.fn().mockReturnValue('Solicitação administrativa'),
      },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(confirmationService.cleanupExpired).toHaveBeenCalledTimes(1);
    expect(confirmationService.create).toHaveBeenCalledWith('admin-1', {
      targetDiscordId: 'discord-target',
      reason: 'Solicitação administrativa',
    });
    expect(interaction.reply.mock.calls[0][0].content).toContain('livepix-account-1');
    expect(interaction.reply.mock.calls[0][0].content).toContain('Kick não serão alterados');
    const [confirm, cancel] = interaction.reply.mock.calls[0][0].components[0].toJSON().components;
    expect(confirm.custom_id).toBe('livepix-unlink-confirm:livepix-token');
    expect(cancel.custom_id).toBe('livepix-unlink-cancel:livepix-token');
  });

  test('confirmação válida remove e audita somente o vínculo LivePix do alvo', async () => {
    confirmationService.validate.mockReturnValue({ ok: true, token: 'livepix-token' });
    confirmationService.consume.mockReturnValue({
      ok: true,
      metadata: { targetDiscordId: 'target-3', reason: 'Compliance' },
    });
    livepixAccountsRepository.unlinkWithAudit.mockReturnValue({ unlinked: true });
    const interaction = {
      customId: 'livepix-unlink-confirm:livepix-token',
      user: { id: 'admin-3' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(confirmationService.validate).toHaveBeenCalledWith('livepix-token', 'admin-3');
    expect(confirmationService.consume).toHaveBeenCalledWith('livepix-token', 'admin-3');
    expect(livepixAccountsRepository.unlinkWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'target-3',
        unlinkedByDiscordId: 'admin-3',
        reason: 'Compliance',
      }),
    );
    expect(kickAccountsRepository.unlinkWithAudit).not.toHaveBeenCalled();
    expect(interaction.update.mock.calls[0][0].content).toContain('Nenhum dado da Kick foi alterado');
    expect(interaction.update.mock.calls[0][0].components[0].toJSON().components.every((button) => button.disabled)).toBe(
      true,
    );
  });

  test('usuário diferente do administrador iniciador não pode confirmar', async () => {
    confirmationService.validate.mockReturnValue({ ok: false, reason: 'forbidden' });
    const interaction = {
      customId: 'livepix-unlink-confirm:livepix-token',
      user: { id: 'other-user' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Esta confirmação pertence a outro usuário.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(confirmationService.consume).not.toHaveBeenCalled();
    expect(livepixAccountsRepository.unlinkWithAudit).not.toHaveBeenCalled();
  });

  test('cancelamento invalida a confirmação sem remover vínculo', async () => {
    confirmationService.validate.mockReturnValue({ ok: true });
    const interaction = {
      customId: 'livepix-unlink-cancel:livepix-token',
      user: { id: 'admin-4' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await cancelButton.execute(interaction);

    expect(confirmationService.invalidate).toHaveBeenCalledWith('livepix-token');
    expect(livepixAccountsRepository.unlinkWithAudit).not.toHaveBeenCalled();
    expect(interaction.update.mock.calls[0][0].content).toContain('cancelada');
  });

  test('confirmação expirada não altera o vínculo', async () => {
    confirmationService.validate.mockReturnValue({ ok: false, reason: 'expired' });
    const interaction = {
      customId: 'livepix-unlink-confirm:expired-token',
      user: { id: 'admin-5' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect(livepixAccountsRepository.unlinkWithAudit).not.toHaveBeenCalled();
  });
});
