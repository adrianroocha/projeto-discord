const { createTestContext } = require('./helpers/testDatabase');

function createInteraction(overrides = {}) {
  return {
    id: 'interaction-1',
    commandName: 'scheduler-open',
    guildId: 'guild-1',
    channelId: 'channel-1',
    user: {
      id: 'mod-1',
      username: 'moderador',
      globalName: 'Moderador Global',
    },
    client: {
      channels: {
        fetch: jest.fn(),
      },
    },
    ...overrides,
  };
}

describe('adminCommandAuditService', () => {
  let context;
  let serviceModule;
  let repository;

  beforeEach(async () => {
    context = await createTestContext({ nodeEnv: 'test' });
    serviceModule = require('../src/services/adminCommandAuditService');
    repository = require('../src/database/adminCommandAuditLogsRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('funciona normalmente sem ADMIN_AUDIT_CHANNEL_ID', async () => {
    const service = serviceModule.createAdminCommandAuditService({
      repository,
      config: {
        adminAuditChannelId: null,
        guildId: 'guild-1',
      },
    });

    const interaction = createInteraction();
    const started = await service.beginRequired(interaction, {
      commandName: 'scheduler-open',
      parameters: {},
      queueCycleId: 10,
      previousState: { state: 'closed', mode: 'production' },
    });

    const finalized = await service.finishSuccess(started, {
      queueCycleId: 11,
      nextState: {
        state: 'open',
        manualCycleReset: true,
      },
      client: interaction.client,
    });

    expect(finalized.auditSaved).toBe(true);
    expect(finalized.auditWarning).toBe('discord_notify_failed');
  });

  test('publica resumo seguro quando canal opcional esta configurado', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const channel = {
      guildId: 'guild-1',
      type: 0,
      isTextBased: () => true,
      send,
    };

    const service = serviceModule.createAdminCommandAuditService({
      repository,
      config: {
        adminAuditChannelId: 'audit-channel-1',
        guildId: 'guild-1',
      },
    });

    const interaction = createInteraction({
      client: {
        channels: {
          fetch: jest.fn().mockResolvedValue(channel),
        },
      },
    });

    const started = await service.beginRequired(interaction, {
      commandName: 'scheduler-close',
      parameters: {},
      previousState: { state: 'open', mode: 'production' },
    });

    const finalized = await service.finishSuccess(started, {
      nextState: {
        state: 'closed',
        manualCyclePreserved: true,
      },
      client: interaction.client,
    });

    expect(finalized.auditSaved).toBe(true);
    expect(finalized.auditWarning).toBeUndefined();
    expect(send).toHaveBeenCalled();

    const payload = send.mock.calls[0][0];
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain('Comando: /scheduler-close');
    expect(payload.content).toContain('Resultado: sucesso');
    expect(payload.content).not.toContain('token');
    expect(payload.content).not.toContain('secret');
    expect(payload.content).not.toContain('stack');
  });

  test('falha ao publicar no Discord nao desfaz auditoria SQLite', async () => {
    const service = serviceModule.createAdminCommandAuditService({
      repository,
      config: {
        adminAuditChannelId: 'audit-channel-1',
        guildId: 'guild-1',
      },
    });

    const interaction = createInteraction({
      client: {
        channels: {
          fetch: jest.fn().mockRejectedValue(Object.assign(new Error('network down'), { code: 'ECONNRESET' })),
        },
      },
    });

    const started = await service.beginRequired(interaction, {
      commandName: 'lobby-start',
      parameters: { numero: 1 },
    });

    const finalized = await service.finishSuccess(started, {
      nextState: { lobbyNumber: 1, nextLobbyState: 'in_game' },
      client: interaction.client,
    });

    expect(finalized.auditSaved).toBe(true);
    expect(finalized.auditWarning).toBe('discord_notify_failed');

    const latest = repository.findLatest();
    expect(latest.result).toBe('success');
  });

  test('idempotencia por interaction_id impede segunda abertura obrigatoria', async () => {
    const service = serviceModule.createAdminCommandAuditService({
      repository,
      config: {
        adminAuditChannelId: null,
        guildId: 'guild-1',
      },
    });

    const interaction = createInteraction({ id: 'same-interaction' });

    await service.beginRequired(interaction, {
      commandName: 'scheduler-open',
      parameters: {},
    });

    await expect(
      service.beginRequired(interaction, {
        commandName: 'scheduler-open',
        parameters: {},
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_INTERACTION' });
  });

  test('nao grava stack trace ou mensagem interna de erro no banco', async () => {
    const service = serviceModule.createAdminCommandAuditService({
      repository,
      config: {
        adminAuditChannelId: null,
        guildId: 'guild-1',
      },
    });

    const interaction = createInteraction({ id: 'safe-int' });
    const started = await service.beginRequired(interaction, {
      commandName: 'lobby-form-force',
      parameters: {
        quantidade: 4,
        exception: 'Error: stacktrace hidden',
      },
    });

    await service.finishFailed(started, {
      errorCode: 'INTERNAL_ERROR',
      nextState: {
        failed: true,
      },
      client: interaction.client,
    });

    const latest = repository.findLatest();
    expect(latest.errorCode).toBe('INTERNAL_ERROR');
    expect(latest.parametersJson).not.toContain('stacktrace');
  });
});
