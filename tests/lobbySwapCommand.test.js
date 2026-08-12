const { MessageFlags } = require('discord.js');

function loadCommand(moduleMocks = {}) {
  jest.resetModules();

  for (const [target, mockValue] of Object.entries(moduleMocks)) {
    jest.doMock(target, () => mockValue);
  }

  return require('../src/commands/lobbySwap');
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
      member: {
        permissions: {
          has: () => true,
        },
      },
      ...overrides,
    }),
  };
}

function createInteraction({
  userAId = 'user-a',
  userBId = 'user-b',
  reason = 'motivo valido',
  memberFetchImpl,
  useLegacyOptionNames = false,
}) {
  const fetchImpl = memberFetchImpl || (async () => ({}));

  return {
    id: 'interaction-swap',
    commandName: 'lobby-swap',
    guildId: 'guild-1',
    channelId: 'channel-1',
    inGuild: () => true,
    user: { id: 'mod-1', username: 'mod' },
    member: {},
    guild: {
      members: {
        fetch: jest.fn(fetchImpl),
      },
    },
    options: {
      getUser: jest.fn().mockImplementation((name) => {
        if (useLegacyOptionNames) {
          if (name === 'usuario_lobby') {
            return { id: userAId };
          }

          if (name === 'usuario_fila') {
            return { id: userBId };
          }

          return null;
        }

        if (name === 'usuario_a') {
          return { id: userAId };
        }

        if (name === 'usuario_b') {
          return { id: userBId };
        }

        return null;
      }),
      getString: jest.fn().mockImplementation((name) => (name === 'motivo' ? reason : null)),
    },
    client: {},
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('lobby-swap command', () => {
  test('builder usa usuario_a e usuario_b obrigatórios, motivo 3..200 e sem default_member_permissions', () => {
    const command = loadCommand({
      '../src/services/queueService': {
        getCurrentQueueCycleId: jest.fn(),
        getQueue: jest.fn(),
        getActiveLobbies: jest.fn(),
        swapParticipantsInCurrentCycle: jest.fn(),
      },
      '../src/services/adminCommandAuditService': createAuditServiceMock(),
      '../src/services/operationalAuthorizationService': createOperationalAuthorizationMock(),
    });
    const json = command.data.toJSON();
    const userA = json.options.find((option) => option.name === 'usuario_a');
    const userB = json.options.find((option) => option.name === 'usuario_b');
    const reason = json.options.find((option) => option.name === 'motivo');

    expect(json.default_member_permissions == null).toBe(true);
    expect(userA.required).toBe(true);
    expect(userB.required).toBe(true);
    expect(reason.required).toBe(true);
    expect(reason.min_length).toBe(3);
    expect(reason.max_length).toBe(200);
    expect(json.options.some((option) => option.name === 'usuario_lobby')).toBe(false);
    expect(json.options.some((option) => option.name === 'usuario_fila')).toBe(false);
  });

  test('sucesso com autorização centralizada registra auditoria e resposta ephemeral', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([{ id: 1 }]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 10, status: 'forming' }]),
      swapParticipantsInCurrentCycle: jest.fn().mockReturnValue({
        success: true,
        userA: {
          origin: { state: 'queue', queuePosition: 2 },
          destination: { state: 'forming_lobby', lobbyId: 10, lobbyNumber: 3, slot: 2 },
        },
        userB: {
          origin: { state: 'forming_lobby', lobbyId: 10, lobbyNumber: 3, slot: 2 },
          destination: { state: 'queue', queuePosition: 2 },
        },
        affectedLobbyNumbers: [3],
        lockedLobbyNumbers: [3],
      }),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationMock({
      via: 'manage_guild',
    });
    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction({
      memberFetchImpl: async (discordId) => ({ id: discordId }),
    });
    await command.execute(interaction);

    expect(authorizationMock.authorize).toHaveBeenCalledWith(interaction);
    expect(queueServiceMock.swapParticipantsInCurrentCycle).toHaveBeenCalledWith({
      discordIdA: 'user-a',
      discordIdB: 'user-b',
      reason: 'motivo valido',
    });
    expect(auditMock.finishSuccess).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        nextState: expect.objectContaining({
          usuarioADiscordId: 'user-a',
          usuarioBDiscordId: 'user-b',
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
      swapParticipantsInCurrentCycle: jest.fn(),
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

    const interaction = createInteraction({
      memberFetchImpl: async (discordId) => ({ id: discordId }),
    });
    await command.execute(interaction);

    expect(auditMock.beginRequired).toHaveBeenCalled();
    expect(auditMock.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MISSING_PERMISSION' }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Você precisa de autorização operacional para executar este comando.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(queueServiceMock.swapParticipantsInCurrentCycle).not.toHaveBeenCalled();
  });

  test('nega quando membro do ator está indisponível e não vaza IDs de cargo', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([{ id: 1 }]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 10, status: 'forming' }]),
      swapParticipantsInCurrentCycle: jest.fn(),
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

    const interaction = createInteraction({
      memberFetchImpl: async (discordId) => ({ id: discordId }),
    });
    await command.execute(interaction);

    expect(auditMock.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MEMBER_UNAVAILABLE' }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não foi possível validar sua autorização operacional neste servidor. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(interaction.reply.mock.calls[0][0].content).not.toContain('1304992476536508516');
    expect(queueServiceMock.swapParticipantsInCurrentCycle).not.toHaveBeenCalled();
  });

  test('falha da troca registra finishFailed com código seguro', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([{ id: 1 }]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 10, status: 'forming' }]),
      swapParticipantsInCurrentCycle: jest.fn().mockReturnValue({
        success: false,
        reason: 'QUEUE_POSITION_CONFLICT',
      }),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationMock();
    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction({
      memberFetchImpl: async (discordId) => ({ id: discordId }),
    });
    await command.execute(interaction);

    expect(auditMock.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'QUEUE_POSITION_CONFLICT' }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Conflito de posição na fila'),
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('não usa checagem inline de permissões no comando', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([{ id: 1 }]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 10, status: 'forming' }]),
      swapParticipantsInCurrentCycle: jest.fn().mockReturnValue({
        success: false,
        reason: 'PARTICIPANT_NOT_FOUND',
      }),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationMock({ via: 'administrator' });
    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction({
      memberFetchImpl: async (discordId) => ({ id: discordId }),
    });

    Object.defineProperty(interaction, 'member', {
      get() {
        throw new Error('inline permission access should not happen');
      },
    });

    await command.execute(interaction);

    expect(authorizationMock.authorize).toHaveBeenCalledTimes(1);
    expect(auditMock.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'PARTICIPANT_NOT_FOUND' }),
    );
  });

  test('falha de auditoria inicial bloqueia mutação no denied', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([{ id: 1 }]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 10, status: 'forming' }]),
      swapParticipantsInCurrentCycle: jest.fn(),
    };

    const auditMock = createAuditServiceMock();
    auditMock.beginRequired.mockRejectedValue(new Error('audit down'));
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

    const interaction = createInteraction({
      memberFetchImpl: async (discordId) => ({ id: discordId }),
    });

    await command.execute(interaction);

    expect(queueServiceMock.swapParticipantsInCurrentCycle).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('compatibilidade defensiva: lê nomes legados em runtime sem manter no builder', async () => {
    const queueServiceMock = {
      getCurrentQueueCycleId: jest.fn().mockReturnValue(12),
      getQueue: jest.fn().mockReturnValue([{ id: 1 }]),
      getActiveLobbies: jest.fn().mockReturnValue([{ id: 10, status: 'forming' }]),
      swapParticipantsInCurrentCycle: jest.fn().mockReturnValue({
        success: true,
        userA: {
          origin: { state: 'forming_lobby', lobbyId: 10, lobbyNumber: 3, slot: 1 },
          destination: { state: 'queue', queuePosition: 1 },
        },
        userB: {
          origin: { state: 'queue', queuePosition: 1 },
          destination: { state: 'forming_lobby', lobbyId: 10, lobbyNumber: 3, slot: 1 },
        },
        affectedLobbyNumbers: [3],
        lockedLobbyNumbers: [3],
      }),
    };

    const auditMock = createAuditServiceMock();
    const authorizationMock = createOperationalAuthorizationMock();
    const command = loadCommand({
      '../src/services/queueService': queueServiceMock,
      '../src/services/adminCommandAuditService': auditMock,
      '../src/services/operationalAuthorizationService': authorizationMock,
    });

    const interaction = createInteraction({
      useLegacyOptionNames: true,
      memberFetchImpl: async (discordId) => ({ id: discordId }),
    });

    await command.execute(interaction);

    expect(queueServiceMock.swapParticipantsInCurrentCycle).toHaveBeenCalledWith({
      discordIdA: 'user-a',
      discordIdB: 'user-b',
      reason: 'motivo valido',
    });
    expect(auditMock.beginRequired).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        parameters: expect.objectContaining({ compat_legacy_option_names: true }),
      }),
    );
  });
});
