const { MessageFlags, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

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

function allowLobbyManagePermissions() {
  return {
    has: (permission) =>
      permission === PermissionsBitField.Flags.Administrator ||
      permission === PermissionsBitField.Flags.ManageGuild,
  };
}

function denyLobbyManagePermissions() {
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

    const queueMessageServiceMock = {
      updatePanel: jest.fn().mockResolvedValue(undefined),
    };

    const auditMock = createAuditServiceMock();

    const command = loadCommand('../src/commands/lobbyFormForce', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/queueMessageService': queueMessageServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
    });

    const interaction = {
      id: 'i-force',
      commandName: 'lobby-form-force',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-3', username: 'mod3' },
      member: { permissions: allowLobbyManagePermissions() },
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

    const queueMessageServiceMock = {
      updatePanel: jest.fn().mockResolvedValue(undefined),
    };

    const auditMock = createAuditServiceMock();

    const command = loadCommand('../src/commands/lobbyStart', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/queueMessageService': queueMessageServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
    });

    const interaction = {
      id: 'i-start',
      commandName: 'lobby-start',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-4', username: 'mod4' },
      member: { permissions: allowLobbyManagePermissions() },
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

    const queueMessageServiceMock = {
      updatePanel: jest.fn().mockResolvedValue(undefined),
    };

    const auditMock = createAuditServiceMock();

    const command = loadCommand('../src/commands/lobbyStart', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/queueMessageService': queueMessageServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
    });

    const interaction = {
      id: 'i-denied',
      commandName: 'lobby-start',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-5', username: 'mod5' },
      member: { permissions: denyLobbyManagePermissions() },
      options: { getInteger: jest.fn().mockReturnValue(null) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(auditMock.beginBestEffort).toHaveBeenCalled();
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

    const queueMessageServiceMock = {
      updatePanel: jest.fn().mockResolvedValue(undefined),
    };

    const auditMock = createAuditServiceMock();

    const command = loadCommand('../src/commands/lobbyStart', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/queueMessageService': queueMessageServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
    });

    const interaction = {
      id: 'i-invalid',
      commandName: 'lobby-start',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-6', username: 'mod6' },
      member: { permissions: allowLobbyManagePermissions() },
      options: { getInteger: jest.fn().mockReturnValue(null) },
      client: {},
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(auditMock.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        errorCode: 'INVALID_INPUT',
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

    const queueMessageServiceMock = {
      updatePanel: jest.fn().mockResolvedValue(undefined),
    };

    const auditMock = createAuditServiceMock();

    const command = loadCommand('../src/commands/lobbyFormForce', {
      '../src/services/queueService': queueServiceMock,
      '../src/services/queueMessageService': queueMessageServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
    });

    const interaction = {
      id: 'i-rule-failure',
      commandName: 'lobby-form-force',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'mod-7', username: 'mod7' },
      member: { permissions: allowLobbyManagePermissions() },
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
});
