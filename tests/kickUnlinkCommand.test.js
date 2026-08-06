jest.mock('../src/database/kickAccountsRepository', () => ({
  findByDiscordId: jest.fn(),
  deleteByDiscordId: jest.fn(),
}));

jest.mock('../src/services/kickUnlinkConfirmationService', () => ({
  cleanupExpired: jest.fn(),
  create: jest.fn(),
  validate: jest.fn(),
  consume: jest.fn(),
  invalidate: jest.fn(),
}));

const kickAccountsRepository = require('../src/database/kickAccountsRepository');
const confirmationService = require('../src/services/kickUnlinkConfirmationService');

const unlinkCommand = require('../src/commands/kickUnlink');
const confirmButton = require('../src/buttons/kickUnlinkConfirm');
const cancelButton = require('../src/buttons/kickUnlinkCancel');

describe('/kick-unlink command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    confirmationService.create.mockReturnValue({
      token: 'token-abc',
      expiresAtMs: 1_700_000_300_000,
    });
  });

  test('usuário sem vínculo recebe aviso', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue(null);

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-1' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await unlinkCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não há conta Kick vinculada ao seu usuário no momento.',
        ephemeral: true,
      }),
    );
    expect(confirmationService.create).not.toHaveBeenCalled();
  });

  test('cria confirmação e mostra botões confirmar/cancelar em resposta ephemeral', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_username: 'adrianroocha',
      kick_user_id: '75942843',
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-2' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await unlinkCommand.execute(interaction);

    expect(confirmationService.cleanupExpired).toHaveBeenCalledTimes(1);
    expect(confirmationService.create).toHaveBeenCalledWith('discord-2', {
      kickUsername: 'adrianroocha',
      kickUserId: '75942843',
    });

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain('adrianroocha');
    expect(payload.components).toHaveLength(1);

    const [confirm, cancel] = payload.components[0].toJSON().components;
    expect(confirm.custom_id).toBe('kick-unlink-confirm:token-abc');
    expect(cancel.custom_id).toBe('kick-unlink-cancel:token-abc');
  });

  test('recusa em DM', async () => {
    const interaction = {
      inGuild: () => false,
      user: { id: 'discord-dm' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await unlinkCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(kickAccountsRepository.findByDiscordId).not.toHaveBeenCalled();
  });
});

describe('kick unlink buttons', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('confirmação válida remove vínculo e desabilita botões', async () => {
    confirmationService.validate.mockReturnValue({ ok: true, token: 'token-ok' });
    confirmationService.consume.mockReturnValue({ ok: true, token: 'token-ok' });
    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_username: 'linked-user',
      kick_user_id: '100',
    });
    kickAccountsRepository.deleteByDiscordId.mockReturnValue(true);

    const interaction = {
      customId: 'kick-unlink-confirm:token-ok',
      user: { id: 'discord-10' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(confirmationService.validate).toHaveBeenCalledWith('token-ok', 'discord-10');
    expect(confirmationService.consume).toHaveBeenCalledWith('token-ok', 'discord-10');
    expect(kickAccountsRepository.findByDiscordId).toHaveBeenCalledWith('discord-10');
    expect(kickAccountsRepository.deleteByDiscordId).toHaveBeenCalledWith('discord-10');

    const payload = interaction.update.mock.calls[0][0];
    expect(payload.content).toContain('Desvinculação concluída com sucesso');
    const [confirm, cancel] = payload.components[0].toJSON().components;
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
  });

  test('cancelamento válido invalida confirmação sem remover vínculo', async () => {
    confirmationService.validate.mockReturnValue({ ok: true, token: 'token-cancel' });

    const interaction = {
      customId: 'kick-unlink-cancel:token-cancel',
      user: { id: 'discord-11' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await cancelButton.execute(interaction);

    expect(confirmationService.invalidate).toHaveBeenCalledWith('token-cancel');
    expect(kickAccountsRepository.deleteByDiscordId).not.toHaveBeenCalled();
    const payload = interaction.update.mock.calls[0][0];
    expect(payload.content).toContain('Desvinculação cancelada');
  });

  test('confirmação expirada responde ephemeral', async () => {
    confirmationService.validate.mockReturnValue({ ok: false, reason: 'expired' });

    const interaction = {
      customId: 'kick-unlink-confirm:token-expired',
      user: { id: 'discord-12' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
      }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  test('confirmação reutilizada responde ephemeral', async () => {
    confirmationService.validate.mockReturnValue({ ok: false, reason: 'already_used' });

    const interaction = {
      customId: 'kick-unlink-confirm:token-used',
      user: { id: 'discord-13' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(confirmationService.consume).not.toHaveBeenCalled();
  });

  test('outro usuário não pode confirmar', async () => {
    confirmationService.validate.mockReturnValue({ ok: false, reason: 'forbidden' });

    const interaction = {
      customId: 'kick-unlink-confirm:token-owner',
      user: { id: 'discord-other' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Esta confirmação pertence a outro usuário.',
        ephemeral: true,
      }),
    );
    expect(confirmationService.consume).not.toHaveBeenCalled();
  });

  test('idempotência quando vínculo já foi removido antes da confirmação', async () => {
    confirmationService.validate.mockReturnValue({ ok: true, token: 'token-idempotent' });
    confirmationService.consume.mockReturnValue({ ok: true, token: 'token-idempotent' });
    kickAccountsRepository.findByDiscordId.mockReturnValue(null);

    const interaction = {
      customId: 'kick-unlink-confirm:token-idempotent',
      user: { id: 'discord-14' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(kickAccountsRepository.deleteByDiscordId).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Nenhum vínculo ativo foi encontrado. A conta já estava desvinculada.',
      }),
    );
  });
});
