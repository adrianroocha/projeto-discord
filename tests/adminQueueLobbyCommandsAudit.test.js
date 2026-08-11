const { MessageFlags, PermissionFlagsBits } = require('discord.js');

function loadCommand(modulePath, moduleMocks = {}) {
  jest.resetModules();

  for (const [target, mockValue] of Object.entries(moduleMocks)) {
    jest.doMock(target, () => mockValue);
  }

  return require(modulePath);
}

function createAuditServiceMock() {
  return {
    normalizeErrorCode: jest.fn((value, fallback) => value || fallback),
    beginRequired: jest.fn().mockResolvedValue({ auditId: 1 }),
    beginBestEffort: jest.fn().mockResolvedValue({ auditId: 2 }),
    finishSuccess: jest.fn().mockResolvedValue({ auditSaved: true }),
    finishFailed: jest.fn().mockResolvedValue({ auditSaved: true }),
    finishDenied: jest.fn().mockResolvedValue({ auditSaved: true }),
  };
}

function createOperationalAuthorizationServiceMock(result = {}) {
  return {
    codes: {
      OK: 'OK',
      MISSING_PERMISSION: 'MISSING_PERMISSION',
      MEMBER_UNAVAILABLE: 'MEMBER_UNAVAILABLE',
      GUILD_UNAVAILABLE: 'GUILD_UNAVAILABLE',
    },
    authorize: jest.fn().mockResolvedValue({
      allowed: true,
      code: 'OK',
      reason: null,
      via: 'manage_guild',
      member: null,
      ...result,
    }),
  };
}

function allowSchedulerManagePermissions() {
  return {
    has: (permission) =>
      permission === PermissionFlagsBits.Administrator ||
      permission === PermissionFlagsBits.ManageGuild,
  };
}

function denySchedulerManagePermissions() {
  return {
    has: () => false,
  };
}

describe('admin queue/lobby commands audit integration', () => {
  test('scheduler-open bem-sucedido', async () => {
    const schedulerServiceMock = {
      openQueue: jest.fn().mockResolvedValue(true),
      getStatus: jest.fn().mockReturnValue({ mode: 'production', state: 'open', origin: 'manual_open' }),
    };

    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(10),
    };

    const auditMock = createAuditServiceMock();

    const command = loadCommand('../src/commands/schedulerOpen', {
      '../src/services/schedulerService': schedulerServiceMock,
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
    });

    const interaction = {
      id: 'i-open',
      commandName: 'scheduler-open',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-1', username: 'mod1' },
      memberPermissions: allowSchedulerManagePermissions(),
      client: {},
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(schedulerServiceMock.openQueue).toHaveBeenCalledWith(interaction.client, { manual: true });
    expect(auditMock.beginRequired).toHaveBeenCalled();
    expect(auditMock.finishSuccess).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith('✅ Fila aberta manualmente.');
  });

  test('scheduler-close bem-sucedido preservando ciclo', async () => {
    const schedulerServiceMock = {
      closeQueue: jest.fn().mockResolvedValue(true),
      getStatus: jest.fn().mockReturnValue({ mode: 'production', state: 'closed', origin: 'manual_close' }),
    };

    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(22),
    };

    const auditMock = createAuditServiceMock();

    const command = loadCommand('../src/commands/schedulerClose', {
      '../src/services/schedulerService': schedulerServiceMock,
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
    });

    const interaction = {
      id: 'i-close',
      commandName: 'scheduler-close',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-2', username: 'mod2' },
      memberPermissions: allowSchedulerManagePermissions(),
      client: {},
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(schedulerServiceMock.closeQueue).toHaveBeenCalledWith(interaction.client, { manual: true });
    expect(auditMock.finishSuccess).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        nextState: expect.objectContaining({
          manualCyclePreserved: true,
        }),
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith('🔒 Fila fechada manualmente. O ciclo atual foi preservado.');
  });

  test('lobby-form-force bem-sucedido', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(3),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      forceCreateLobby: jest.fn().mockReturnValue({
        success: true,
        entries: [
          { display_name: 'A', username: 'a' },
          { display_name: 'B', username: 'b' },
          { display_name: 'C', username: 'c' },
          { display_name: 'D', username: 'd' },
        ],
        lobbyId: 10,
        lobbyNumber: 1,
      }),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationServiceMock();

    const command = loadCommand('../src/commands/lobbyFormForce', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = {
      id: 'i-force',
      commandName: 'lobby-form-force',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-3', username: 'mod3' },
      options: { getInteger: jest.fn().mockReturnValue(4) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(queueServiceMock.forceCreateLobby).toHaveBeenCalledWith(4);
    expect(auditMock.finishSuccess).toHaveBeenCalled();
  });

  test('lobby-start bem-sucedido', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(4),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 8, lobbyNumber: 9, status: 'forming', players: [] }]),
      startLobbyByNumber: jest.fn().mockReturnValue(true),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationServiceMock();

    const command = loadCommand('../src/commands/lobbyStart', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = {
      id: 'i-start',
      commandName: 'lobby-start',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-4', username: 'mod4' },
      options: { getInteger: jest.fn().mockReturnValue(9) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(queueServiceMock.startLobbyByNumber).toHaveBeenCalledWith(9);
    expect(auditMock.finishSuccess).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        nextState: expect.objectContaining({
          lobbyNumber: 9,
          nextLobbyState: 'in_game',
        }),
      }),
    );
  });

  test('tentativa sem permissao registrada como denied', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(4),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      startLobbyByNumber: jest.fn(),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationServiceMock({
      allowed: false,
      code: 'MISSING_PERMISSION',
      reason: 'missing_permission',
      via: null,
    });

    const command = loadCommand('../src/commands/lobbyStart', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = {
      id: 'i-denied',
      commandName: 'lobby-start',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-5', username: 'mod5' },
      options: { getInteger: jest.fn().mockReturnValue(null) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(auditMock.beginRequired).toHaveBeenCalled();
    expect(auditMock.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MISSING_PERMISSION' }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  test('entrada invalida e registrada como failed', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(6),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([
        { id: 1, lobbyNumber: 10, status: 'forming', players: [] },
        { id: 2, lobbyNumber: 11, status: 'forming', players: [] },
      ]),
      startLobbyByNumber: jest.fn(),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationServiceMock();

    const command = loadCommand('../src/commands/lobbyStart', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = {
      id: 'i-invalid',
      commandName: 'lobby-start',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-6', username: 'mod6' },
      options: { getInteger: jest.fn().mockReturnValue(null) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(auditMock.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        errorCode: 'LOBBY_NUMBER_REQUIRED',
      }),
    );
  });

  test('falha de regra de negocio usa codigo seguro', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(9),
      getQueue: jest.fn().mockReturnValue([{ id: 1 }]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      forceCreateLobby: jest.fn().mockReturnValue({ success: false, available: 1 }),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationServiceMock();

    const command = loadCommand('../src/commands/lobbyFormForce', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = {
      id: 'i-rule-failure',
      commandName: 'lobby-form-force',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-7', username: 'mod7' },
      options: { getInteger: jest.fn().mockReturnValue(4) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(auditMock.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'INSUFFICIENT_PLAYERS' }),
    );
  });

  test('lobby-form-force permite cargo operacional configurado', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(11),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      forceCreateLobby: jest.fn().mockReturnValue({
        success: true,
        entries: [{ display_name: 'A', username: 'a' }],
        lobbyId: 44,
        lobbyNumber: 9,
      }),
    };
    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationServiceMock({
      allowed: true,
      via: 'operator_role',
    });

    const command = loadCommand('../src/commands/lobbyFormForce', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = {
      id: 'i-force-operator-role',
      commandName: 'lobby-form-force',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-operator', username: 'modOperator' },
      options: { getInteger: jest.fn().mockReturnValue(1) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(queueServiceMock.forceCreateLobby).toHaveBeenCalledWith(1);
    expect(auditMock.finishSuccess).toHaveBeenCalled();
  });

  test('lobby-form-force recusa usuário comum e audita denied', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      forceCreateLobby: jest.fn(),
    };
    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationServiceMock({
      allowed: false,
      code: 'MISSING_PERMISSION',
      reason: 'missing_permission',
      via: null,
    });

    const command = loadCommand('../src/commands/lobbyFormForce', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = {
      id: 'i-force-denied',
      commandName: 'lobby-form-force',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'user-common', username: 'userCommon' },
      options: { getInteger: jest.fn().mockReturnValue(1) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(queueServiceMock.forceCreateLobby).not.toHaveBeenCalled();
    expect(auditMock.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MISSING_PERMISSION' }),
    );
  });

  test('falha de auditoria inicial bloqueia mutação em lobby-start', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(13),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 1, lobbyNumber: 1, status: 'forming', players: [] }]),
      startLobbyByNumber: jest.fn(),
    };
    const auditMock = createAuditServiceMock();
    auditMock.beginRequired.mockRejectedValue(new Error('sqlite down'));
    const authorizationMock = createOperationalAuthorizationServiceMock();

    const command = loadCommand('../src/commands/lobbyStart', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = {
      id: 'i-start-audit-fail',
      commandName: 'lobby-start',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-audit-fail', username: 'modAuditFail' },
      options: { getInteger: jest.fn().mockReturnValue(1) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(queueServiceMock.startLobbyByNumber).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('falha de auditoria inicial bloqueia mutação em lobby-form-force', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(14),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      forceCreateLobby: jest.fn(),
    };
    const auditMock = createAuditServiceMock();
    auditMock.beginRequired.mockRejectedValue(new Error('sqlite down'));
    const authorizationMock = createOperationalAuthorizationServiceMock();

    const command = loadCommand('../src/commands/lobbyFormForce', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = {
      id: 'i-force-audit-fail',
      commandName: 'lobby-form-force',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-force-audit-fail', username: 'modForceAuditFail' },
      options: { getInteger: jest.fn().mockReturnValue(1) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(queueServiceMock.forceCreateLobby).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('idempotencia por interaction_id bloqueia segunda tentativa', async () => {
    const schedulerServiceMock = {
      openQueue: jest.fn().mockResolvedValue(true),
      getStatus: jest.fn().mockReturnValue({ mode: 'production', state: 'open', origin: 'manual_open' }),
    };

    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(10),
    };

    const auditMock = createAuditServiceMock();
    auditMock.beginRequired
      .mockResolvedValueOnce({ auditId: 1 })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 'DUPLICATE_INTERACTION' }));

    const command = loadCommand('../src/commands/schedulerOpen', {
      '../src/services/schedulerService': schedulerServiceMock,
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
    });

    const interaction = {
      id: 'i-duplicate',
      commandName: 'scheduler-open',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-8', username: 'mod8' },
      memberPermissions: allowSchedulerManagePermissions(),
      client: {},
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);
    await command.execute(interaction);

    expect(schedulerServiceMock.openQueue).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('erro na regra principal registra failed com codigo seguro', async () => {
    const schedulerServiceMock = {
      openQueue: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'QUEUE_STATE_ERROR' })),
      getStatus: jest.fn().mockReturnValue({ mode: 'production', state: 'closed', origin: 'scheduled' }),
    };

    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(10),
    };

    const auditMock = createAuditServiceMock();

    const command = loadCommand('../src/commands/schedulerOpen', {
      '../src/services/schedulerService': schedulerServiceMock,
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
    });

    const interaction = {
      id: 'i-failed',
      commandName: 'scheduler-open',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-9', username: 'mod9' },
      memberPermissions: allowSchedulerManagePermissions(),
      client: {},
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await expect(command.execute(interaction)).rejects.toThrow('boom');

    expect(auditMock.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'QUEUE_STATE_ERROR' }),
    );
  });

  test('sem permissao scheduler-open responde denied no fluxo', async () => {
    const schedulerServiceMock = {
      openQueue: jest.fn().mockResolvedValue(true),
      getStatus: jest.fn().mockReturnValue({ mode: 'production', state: 'closed', origin: 'scheduled' }),
    };

    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(10),
    };

    const auditMock = createAuditServiceMock();

    const command = loadCommand('../src/commands/schedulerOpen', {
      '../src/services/schedulerService': schedulerServiceMock,
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
    });

    const interaction = {
      id: 'i-open-denied',
      commandName: 'scheduler-open',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-denied', username: 'modDenied' },
      memberPermissions: denySchedulerManagePermissions(),
      client: {},
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(auditMock.finishDenied).toHaveBeenCalled();
    expect(schedulerServiceMock.openQueue).not.toHaveBeenCalled();
  });

  test('lobby-start builder exige numero com mínimo 1', () => {
    const authorizationMock = createOperationalAuthorizationServiceMock();
    const command = loadCommand('../src/commands/lobbyStart', {
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const json = command.data.toJSON();
    const option = json.options.find((entry) => entry.name === 'numero');

    expect(option.required).toBe(true);
    expect(option.min_value).toBe(1);
  });
});
