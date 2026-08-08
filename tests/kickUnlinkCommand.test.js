jest.mock('../src/database/kickAccountsRepository', () => ({
  findByDiscordId: jest.fn(),
  unlinkWithAudit: jest.fn(),
}));

jest.mock('../src/services/kickUnlinkConfirmationService', () => ({
  cleanupExpired: jest.fn(),
  create: jest.fn(),
  validate: jest.fn(),
  consume: jest.fn(),
  invalidate: jest.fn(),
}));

jest.mock('../src/services/subscriberRoleAutoSyncService', () => ({
  syncAfterEligibilityChange: jest.fn(),
}));

const kickAccountsRepository = require('../src/database/kickAccountsRepository');
const confirmationService = require('../src/services/kickUnlinkConfirmationService');
const autoSyncService = require('../src/services/subscriberRoleAutoSyncService');
const { PermissionFlagsBits } = require('discord.js');

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
    autoSyncService.syncAfterEligibilityChange.mockResolvedValue({
      status: 'synced',
      eligibility: false,
      sources: { kick: false, manual: false },
      roleState: 'removed',
    });
  });

  function makePermissions(isAdmin) {
    return {
      has: (flag) => isAdmin && flag === PermissionFlagsBits.Administrator,
    };
  }

  test('somente Administrator pode usar', async () => {
    const interaction = {
      inGuild: () => true,
      memberPermissions: makePermissions(false),
      user: { id: 'admin-1' },
      options: {
        getUser: jest.fn(),
        getString: jest.fn(),
      },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await unlinkCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
      }),
    );
    expect(kickAccountsRepository.findByDiscordId).not.toHaveBeenCalled();
  });

  test('schema exige opções obrigatórias usuario e motivo', () => {
    const json = unlinkCommand.data.toJSON();
    const userOption = json.options.find((opt) => opt.name === 'usuario');
    const reasonOption = json.options.find((opt) => opt.name === 'motivo');

    expect(userOption).toBeDefined();
    expect(reasonOption).toBeDefined();
    expect(userOption.required).toBe(true);
    expect(reasonOption.required).toBe(true);
  });

  test('usuário alvo sem vínculo recebe aviso', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue(null);

    const interaction = {
      inGuild: () => true,
      memberPermissions: makePermissions(true),
      user: { id: 'admin-1' },
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'discord-1', bot: false }),
        getString: jest.fn().mockReturnValue('Solicitação do usuário'),
      },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await unlinkCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não há conta Kick vinculada para <@discord-1> no momento.',
        ephemeral: true,
      }),
    );
    expect(confirmationService.create).not.toHaveBeenCalled();
  });

  test('motivo vazio é rejeitado', async () => {
    const interaction = {
      inGuild: () => true,
      memberPermissions: makePermissions(true),
      user: { id: 'admin-blank-reason' },
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'discord-any', bot: false }),
        getString: jest.fn().mockReturnValue('   '),
      },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await unlinkCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'O motivo da desvinculação é obrigatório.',
        ephemeral: true,
      }),
    );
    expect(kickAccountsRepository.findByDiscordId).not.toHaveBeenCalled();
  });

  test('cria confirmação administrativa com usuário alvo e motivo', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_username: 'adrianroocha',
      kick_user_id: '75942843',
    });

    const interaction = {
      inGuild: () => true,
      memberPermissions: makePermissions(true),
      user: { id: 'admin-2' },
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'discord-2', bot: false }),
        getString: jest.fn().mockReturnValue('Solicitação por segurança'),
      },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await unlinkCommand.execute(interaction);

    expect(confirmationService.cleanupExpired).toHaveBeenCalledTimes(1);
    expect(confirmationService.create).toHaveBeenCalledWith('admin-2', {
      targetDiscordId: 'discord-2',
      kickUsername: 'adrianroocha',
      kickUserId: '75942843',
      reason: 'Solicitação por segurança',
    });

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain('adrianroocha');
    expect(payload.content).toContain('<@discord-2>');
    expect(payload.content).toContain('Motivo: Solicitação por segurança');
    expect(payload.components).toHaveLength(1);

    const [confirm, cancel] = payload.components[0].toJSON().components;
    expect(confirm.custom_id).toBe('kick-unlink-confirm:token-abc');
    expect(cancel.custom_id).toBe('kick-unlink-cancel:token-abc');
  });

  test('recusa em DM', async () => {
    const interaction = {
      inGuild: () => false,
      user: { id: 'admin-dm' },
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

  test('confirmação válida remove vínculo do usuário alvo e audita transação', async () => {
    confirmationService.validate.mockReturnValue({ ok: true, token: 'token-ok' });
    confirmationService.consume.mockReturnValue({
      ok: true,
      token: 'token-ok',
      metadata: {
        targetDiscordId: 'discord-target',
        reason: 'Compliance',
      },
    });
    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_username: 'linked-user',
      kick_user_id: '100',
    });
    kickAccountsRepository.unlinkWithAudit.mockReturnValue({ unlinked: true });

    const interaction = {
      customId: 'kick-unlink-confirm:token-ok',
      user: { id: 'admin-10' },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(confirmationService.validate).toHaveBeenCalledWith('token-ok', 'admin-10');
    expect(confirmationService.consume).toHaveBeenCalledWith('token-ok', 'admin-10');
    expect(kickAccountsRepository.findByDiscordId).toHaveBeenCalledWith('discord-target');
    expect(kickAccountsRepository.unlinkWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'discord-target',
        unlinkedByDiscordId: 'admin-10',
        reason: 'Compliance',
      }),
    );
    expect(autoSyncService.syncAfterEligibilityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'discord-target',
        triggerType: 'kick_unlink',
        triggeredByDiscordId: 'admin-10',
      }),
    );

    const payload = interaction.update.mock.calls[0][0];
    expect(payload.content).toContain('Desvinculação concluída para <@discord-target>');
    expect(payload.content).toContain('Estado do cargo SUB: removido');
    const [confirm, cancel] = payload.components[0].toJSON().components;
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
  });

  test('desvinculação permanece concluída quando sync falha', async () => {
    confirmationService.validate.mockReturnValue({ ok: true, token: 'token-pending' });
    confirmationService.consume.mockReturnValue({
      ok: true,
      token: 'token-pending',
      metadata: {
        targetDiscordId: 'discord-pending',
        reason: 'Compliance',
      },
    });
    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_username: 'linked-user',
      kick_user_id: '100',
    });
    kickAccountsRepository.unlinkWithAudit.mockReturnValue({ unlinked: true });
    autoSyncService.syncAfterEligibilityChange.mockResolvedValue({
      status: 'warning',
      eligibility: null,
      sources: { kick: false, manual: false },
      roleState: 'pending',
    });

    const interaction = {
      customId: 'kick-unlink-confirm:token-pending',
      user: { id: 'admin-10' },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    const payload = interaction.update.mock.calls[0][0];
    expect(payload.content).toContain('Desvinculação concluída para <@discord-pending>');
    expect(payload.content).toContain('sincronização automática do cargo ficou pendente');
    expect(payload.content).not.toContain('Prioridade na fila:');
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
    expect(kickAccountsRepository.unlinkWithAudit).not.toHaveBeenCalled();
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

  test('idempotência quando vínculo do alvo já foi removido antes da confirmação', async () => {
    confirmationService.validate.mockReturnValue({ ok: true, token: 'token-idempotent' });
    confirmationService.consume.mockReturnValue({
      ok: true,
      token: 'token-idempotent',
      metadata: {
        targetDiscordId: 'discord-14',
        reason: 'Pedido do usuário',
      },
    });
    kickAccountsRepository.findByDiscordId.mockReturnValue(null);

    const interaction = {
      customId: 'kick-unlink-confirm:token-idempotent',
      user: { id: 'discord-14' },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(kickAccountsRepository.unlinkWithAudit).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Nenhum vínculo ativo foi encontrado para <@discord-14>. A conta já estava desvinculada.',
      }),
    );
  });

  test('confirmação inválida por metadados ausentes', async () => {
    confirmationService.validate.mockReturnValue({ ok: true, token: 'token-bad' });
    confirmationService.consume.mockReturnValue({ ok: true, token: 'token-bad', metadata: {} });

    const interaction = {
      customId: 'kick-unlink-confirm:token-bad',
      user: { id: 'admin-20' },
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };

    await confirmButton.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(kickAccountsRepository.unlinkWithAudit).not.toHaveBeenCalled();
  });
});
