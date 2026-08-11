const { MessageFlags } = require('discord.js');

function loadCommand(moduleMocks = {}) {
  jest.resetModules();

  for (const [target, mockValue] of Object.entries(moduleMocks)) {
    jest.doMock(target, () => mockValue);
  }

  return require('../src/commands/lobbyRemove');
}

function createAuditServiceMock() {
  return {
    normalizeErrorCode: jest.fn((value, fallback) => value || fallback),
    beginRequired: jest.fn().mockResolvedValue({ auditId: 1 }),
    finishSuccess: jest.fn().mockResolvedValue({ auditSaved: true }),
    finishFailed: jest.fn().mockResolvedValue({ auditSaved: true }),
    finishDenied: jest.fn().mockResolvedValue({ auditSaved: true }),
  };
}

function createOperationalAuthorizationMock(overrides = {}) {
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
      member: {},
      ...overrides,
    }),
  };
}

function createInteraction({ targetId = 'user-a', reason = 'Jogador ausente' } = {}) {
  return {
    id: 'interaction-remove',
    commandName: 'lobby-remove',
    guildId: 'guild-1',
    channelId: 'channel-1',
    inGuild: () => true,
    user: { id: 'mod-1', username: 'mod' },
    guild: {
      members: {
        fetch: jest.fn(async () => ({})),
      },
    },
    options: {
      getUser: jest.fn().mockImplementation((name) => (name === 'usuario' ? (targetId ? { id: targetId } : null) : null)),
      getString: jest.fn().mockImplementation((name) => (name === 'motivo' ? reason : null)),
    },
    client: {},
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('lobby-remove command', () => {
  test('builder define usuario obrigatório, motivo obrigatório 3-200 e sem default_member_permissions', () => {
    const command = loadCommand({
      '../src/services/queueService': {
        getCurrentQueueCycleId: jest.fn(),
        getQueue: jest.fn().mockReturnValue([]),
        getActiveLobbies: jest.fn().mockReturnValue([]),
        removePlayerFromLobbyByDiscordId: jest.fn(),
      },
      '../src/services/adminCommandAuditService': createAuditServiceMock(),
      '../src/services/operationalAuthorizationService': createOperationalAuthorizationMock(),
    });

    const json = command.data.toJSON();
    const userOption = json.options.find((option) => option.name === 'usuario');
    const reasonOption = json.options.find((option) => option.name === 'motivo');

    expect(userOption.type).toBe(6);
    expect(userOption.required).toBe(true);
    expect(reasonOption.type).toBe(3);
    expect(reasonOption.required).toBe(true);
    expect(reasonOption.min_length).toBe(3);
    expect(reasonOption.max_length).toBe(200);
    expect(json.default_member_permissions == null).toBe(true);
  });

  test.each([
    ['administrator', 'administrator'],
    ['manage_guild', 'manage_guild'],
    ['operator_role', 'operator_role'],
  ])('permite execução quando autorizado via %s', async (_label, via) => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([{ id: 1 }]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 10, status: 'forming' }]),
      removePlayerFromLobbyByDiscordId: jest.fn().mockReturnValue({
        success: true,
        lobbyId: 10,
        lobbyNumber: 3,
        lobbyCreationType: 'automatic',
        slot: 2,
        removedQueueEntries: 1,
        removedQueueOverrideEntries: 1,
        unlockedRebuild: true,
      }),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationMock({
      allowed: true,
      via,
    });
    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction();
    await command.execute(interaction);

    expect(queueServiceMock.removePlayerFromLobbyByDiscordId).toHaveBeenCalledWith({
      lobbyDiscordId: 'user-a',
      reason: 'Jogador ausente',
    });
    expect(auditMock.finishSuccess).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        nextState: expect.objectContaining({
          targetDiscordId: 'user-a',
          returnedToQueue: false,
        }),
      }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('nega usuário comum com denied auditado e sem mutação', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([{ id: 1 }]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 10, status: 'forming' }]),
      removePlayerFromLobbyByDiscordId: jest.fn(),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationMock({
      allowed: false,
      code: 'MISSING_PERMISSION',
      reason: 'missing_permission',
      via: null,
    });
    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction();
    await command.execute(interaction);

    expect(auditMock.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MISSING_PERMISSION' }),
    );
    expect(queueServiceMock.removePlayerFromLobbyByDiscordId).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Você precisa de autorização operacional para executar este comando.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('membro do moderador indisponível recusa com mensagem segura sem vazar IDs de cargos', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([{ id: 1 }]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 10, status: 'forming' }]),
      removePlayerFromLobbyByDiscordId: jest.fn(),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationMock({
      allowed: false,
      code: 'MEMBER_UNAVAILABLE',
      reason: 'member_unavailable',
      via: null,
    });

    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction();
    await command.execute(interaction);

    expect(auditMock.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MEMBER_UNAVAILABLE' }),
    );
    expect(interaction.reply.mock.calls[0][0].content).toBe(
      'Não foi possível validar sua autorização operacional neste servidor. Operação recusada.',
    );
    expect(interaction.reply.mock.calls[0][0].content).not.toContain('1304992476536508516');
  });

  test('alvo indisponível no Discord não bloqueia comando por depender apenas do discord_id', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(5),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      removePlayerFromLobbyByDiscordId: jest.fn().mockReturnValue({
        success: true,
        lobbyId: 21,
        lobbyNumber: 8,
        lobbyCreationType: 'automatic',
        slot: 1,
        removedQueueEntries: 0,
        removedQueueOverrideEntries: 0,
        unlockedRebuild: false,
      }),
    };
    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationMock();

    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction({ targetId: 'offline-target' });
    await command.execute(interaction);

    expect(queueServiceMock.removePlayerFromLobbyByDiscordId).toHaveBeenCalledWith({
      lobbyDiscordId: 'offline-target',
      reason: 'Jogador ausente',
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test.each([
    [null, 'motivo ausente'],
    ['ab', 'motivo curto'],
    ['x'.repeat(201), 'motivo longo'],
  ])('motivo inválido (%s) registra failed INVALID_INPUT', async (reason) => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      removePlayerFromLobbyByDiscordId: jest.fn(),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationMock();
    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction({ reason });
    await command.execute(interaction);

    expect(auditMock.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'INVALID_INPUT' }),
    );
    expect(queueServiceMock.removePlayerFromLobbyByDiscordId).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  test('falha da auditoria inicial bloqueia mutação', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      removePlayerFromLobbyByDiscordId: jest.fn(),
    };

    const auditMock = createAuditServiceMock();
    auditMock.beginRequired.mockRejectedValue(new Error('sqlite down'));
    const authorizationMock = createOperationalAuthorizationMock();
    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction();
    await command.execute(interaction);

    expect(queueServiceMock.removePlayerFromLobbyByDiscordId).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('idempotência por interaction_id bloqueia segunda tentativa', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      removePlayerFromLobbyByDiscordId: jest.fn().mockReturnValue({
        success: true,
        lobbyId: 10,
        lobbyNumber: 1,
        lobbyCreationType: 'automatic',
        slot: 1,
        removedQueueEntries: 0,
        removedQueueOverrideEntries: 0,
        unlockedRebuild: false,
      }),
    };

    const auditMock = createAuditServiceMock();
    auditMock.beginRequired
      .mockResolvedValueOnce({ auditId: 1 })
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'DUPLICATE_INTERACTION' }));

    const authorizationMock = createOperationalAuthorizationMock();
    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction();
    await command.execute(interaction);
    await command.execute(interaction);

    expect(queueServiceMock.removePlayerFromLobbyByDiscordId).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: 'Esta interação já foi processada anteriormente.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('falha de domínio usa código seguro sem dados sensíveis', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([]),
      getActiveLobbies: jest.fn().mockReturnValue([]),
      removePlayerFromLobbyByDiscordId: jest.fn().mockReturnValue({
        success: false,
        reason: 'LOBBY_IMMUTABLE',
      }),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationMock();
    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction();
    await command.execute(interaction);

    expect(auditMock.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'LOBBY_IMMUTABLE' }),
    );
    expect(interaction.reply.mock.calls[0][0].content).toContain('lobby em andamento');
    expect(JSON.stringify(auditMock.finishFailed.mock.calls)).not.toMatch(/token|secret|payload|stack/i);
  });
});
