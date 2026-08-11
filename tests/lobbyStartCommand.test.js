const { EventEmitter } = require('events');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const {
  createTestContext,
  getDb,
  insertLobby,
  insertLobbyPlayer,
} = require('./helpers/testDatabase');

function flushAsyncWork() {
  return new Promise((resolve) => global.setImmediate(resolve));
}

function createPanelClient(channelId = 'panel-channel', options = {}) {
  const client = new EventEmitter();
  const existingMessage = {
    id: 'panel-msg',
    author: { id: 'bot-user' },
    content: '# 🎮 Sistema de Fila',
    edit: options.editRejects
      ? jest.fn().mockRejectedValue(new Error('panel failed'))
      : jest.fn().mockResolvedValue(undefined),
  };

  const channel = {
    id: channelId,
    client,
    isTextBased: () => true,
    send: jest.fn().mockResolvedValue(existingMessage),
    messages: {
      fetch: jest.fn().mockImplementation(async (arg) => {
        if (typeof arg === 'string') {
          return existingMessage;
        }

        return new Map();
      }),
    },
  };

  client.user = { id: 'bot-user' };
  client.queuePanelMessageId = 'panel-msg';
  client.channels = {
    fetch: jest.fn().mockResolvedValue(channel),
  };

  return { client, channel, existingMessage };
}

function makeInteraction(client, options = {}) {
  const actorId = options.actorId || 'mod-1';
  const actorFlags = options.actorFlags || [PermissionFlagsBits.ManageGuild];
  const actorRoleIds = options.actorRoleIds || [];

  return {
    id: options.id || 'interaction-1',
    commandName: 'lobby-start',
    guildId: 'test-guild',
    channelId: 'channel-1',
    inGuild: () => true,
    guild: {
      members: {
        fetch: jest.fn(async (discordId) => {
          if (options.memberUnavailable || discordId !== actorId) {
            throw new Error('member unavailable');
          }

          return {
            permissions: {
              has: (flag) => actorFlags.includes(flag),
            },
            roles: {
              cache: {
                has: (roleId) => actorRoleIds.includes(roleId),
              },
            },
          };
        }),
      },
    },
    user: { id: actorId, username: actorId },
    options: {
      getInteger: jest.fn().mockReturnValue(options.lobbyNumber),
    },
    client,
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('/lobby-start command integration', () => {
  let context;
  let db;
  let command;
  let queueEvents;
  let queueMessageService;
  let auditRepository;
  let consoleWarnSpy;

  beforeEach(async () => {
    context = await createTestContext({
      nodeEnv: 'test',
      queuePanelChannelId: 'panel-channel',
      botOperatorRoleIds: '900000000000000001,900000000000000002',
    });
    db = getDb(context.sqliteClient);
    queueEvents = context.queueEvents;
    command = require('../src/commands/lobbyStart');
    queueMessageService = require('../src/services/queueMessageService');
    auditRepository = require('../src/database/adminCommandAuditLogsRepository');
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    queueEvents.removeAllListeners('queueUpdated');
    consoleWarnSpy.mockRestore();
    await context.cleanup();
  });

  test('inicia lobby em forming com exatamente uma atualização de painel e auditoria success', async () => {
    insertLobby(db, {
      id: 1,
      lobbyNumber: 1,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 1_000,
    });
    insertLobbyPlayer(db, {
      id: 1,
      lobbyId: 1,
      discordId: 'player-1',
      username: 'Player 1#0001',
      displayName: 'Player 1',
      position: 1,
      originalJoinedAtMs: 1_000,
      isSubscriber: 0,
    });

    const { client, existingMessage } = createPanelClient();
    queueMessageService.startPanelUpdater(client);
    const interaction = makeInteraction(client, { lobbyNumber: 1 });

    await command.execute(interaction);
    await flushAsyncWork();

    expect(existingMessage.edit).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT status FROM lobbies WHERE id = 1').get().status).toBe('in_game');
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Lobby #1 iniciada com sucesso.',
        flags: MessageFlags.Ephemeral,
      }),
    );

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('success');
    expect(latest.errorCode).toBe('OK');
    expect(latest.parametersJson).toContain('"numero":1');
  });

  test('cargo operacional configurado pode iniciar lobby', async () => {
    insertLobby(db, {
      id: 2,
      lobbyNumber: 2,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 2_000,
    });
    insertLobbyPlayer(db, {
      id: 2,
      lobbyId: 2,
      discordId: 'player-2',
      username: 'Player 2#0001',
      displayName: 'Player 2',
      position: 1,
      originalJoinedAtMs: 2_000,
      isSubscriber: 0,
    });

    const { client } = createPanelClient();
    const interaction = makeInteraction(client, {
      actorFlags: [],
      actorRoleIds: ['900000000000000002'],
      lobbyNumber: 2,
      id: 'interaction-operator-role',
    });

    await command.execute(interaction);

    expect(db.prepare('SELECT status FROM lobbies WHERE id = 2').get().status).toBe('in_game');
  });

  test('lobby em estado open continua startable pela regra canônica do domínio', async () => {
    insertLobby(db, {
      id: 3,
      lobbyNumber: 3,
      status: 'open',
      creationType: 'automatic',
      createdAtMs: 3_000,
    });
    insertLobbyPlayer(db, {
      id: 3,
      lobbyId: 3,
      discordId: 'player-3',
      username: 'Player 3#0001',
      displayName: 'Player 3',
      position: 1,
      originalJoinedAtMs: 3_000,
      isSubscriber: 0,
    });

    const { client } = createPanelClient();
    const interaction = makeInteraction(client, { lobbyNumber: 3, id: 'interaction-open-state' });

    await command.execute(interaction);

    expect(db.prepare('SELECT status FROM lobbies WHERE id = 3').get().status).toBe('in_game');
  });

  test('ausência defensiva do número não inicia mesmo com uma única lobby', async () => {
    insertLobby(db, {
      id: 4,
      lobbyNumber: 4,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 4_000,
    });

    const { client, existingMessage } = createPanelClient();
    queueMessageService.startPanelUpdater(client);
    const interaction = makeInteraction(client, { lobbyNumber: null, id: 'interaction-missing-number' });

    await command.execute(interaction);
    await flushAsyncWork();

    expect(existingMessage.edit).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM lobbies WHERE id = 4').get().status).toBe('forming');

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('failed');
    expect(latest.errorCode).toBe('LOBBY_NUMBER_REQUIRED');
  });

  test('zero é rejeitado com código seguro', async () => {
    const { client } = createPanelClient();
    const interaction = makeInteraction(client, { lobbyNumber: 0, id: 'interaction-zero' });

    await command.execute(interaction);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('failed');
    expect(latest.errorCode).toBe('INVALID_LOBBY_NUMBER');
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'O número da lobby deve ser um inteiro maior ou igual a 1.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('negativo é rejeitado com código seguro', async () => {
    const { client } = createPanelClient();
    const interaction = makeInteraction(client, { lobbyNumber: -1, id: 'interaction-negative' });

    await command.execute(interaction);

    const latest = auditRepository.findLatest();
    expect(latest.errorCode).toBe('INVALID_LOBBY_NUMBER');
  });

  test('valor não inteiro é rejeitado defensivamente', async () => {
    const { client } = createPanelClient();
    const interaction = makeInteraction(client, { lobbyNumber: 1.5, id: 'interaction-non-integer' });

    await command.execute(interaction);

    const latest = auditRepository.findLatest();
    expect(latest.errorCode).toBe('INVALID_LOBBY_NUMBER');
  });

  test('número inexistente falha com LOBBY_NOT_FOUND', async () => {
    insertLobby(db, {
      id: 5,
      lobbyNumber: 8,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 5_000,
    });

    const { client, existingMessage } = createPanelClient();
    queueMessageService.startPanelUpdater(client);
    const interaction = makeInteraction(client, { lobbyNumber: 7, id: 'interaction-not-found' });

    await command.execute(interaction);
    await flushAsyncWork();

    expect(existingMessage.edit).not.toHaveBeenCalled();
    const latest = auditRepository.findLatest();
    expect(latest.errorCode).toBe('LOBBY_NOT_FOUND');
  });

  test('lobby in_game permanece imutável', async () => {
    insertLobby(db, {
      id: 6,
      lobbyNumber: 6,
      status: 'in_game',
      creationType: 'automatic',
      createdAtMs: 6_000,
    });

    const { client } = createPanelClient();
    const interaction = makeInteraction(client, { lobbyNumber: 6, id: 'interaction-in-game' });

    await command.execute(interaction);

    expect(db.prepare('SELECT status FROM lobbies WHERE id = 6').get().status).toBe('in_game');
    const latest = auditRepository.findLatest();
    expect(latest.errorCode).toBe('LOBBY_NOT_FOUND');
  });

  test('idempotência por interaction_id impede segunda mutação', async () => {
    insertLobby(db, {
      id: 7,
      lobbyNumber: 7,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 7_000,
    });

    const { client } = createPanelClient();
    const interaction = makeInteraction(client, { lobbyNumber: 7, id: 'interaction-idempotent' });

    await command.execute(interaction);
    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('falha de painel após mutação não deixa auditoria pending', async () => {
    insertLobby(db, {
      id: 8,
      lobbyNumber: 8,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 8_000,
    });
    insertLobbyPlayer(db, {
      id: 8,
      lobbyId: 8,
      discordId: 'player-8',
      username: 'Player 8#0001',
      displayName: 'Player 8',
      position: 1,
      originalJoinedAtMs: 8_000,
      isSubscriber: 0,
    });

    const { client } = createPanelClient('panel-channel', { editRejects: true });
    queueMessageService.startPanelUpdater(client);
    const interaction = makeInteraction(client, { lobbyNumber: 8, id: 'interaction-panel-failure' });

    await command.execute(interaction);
    await flushAsyncWork();

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('success');
    expect(consoleWarnSpy).toHaveBeenCalledWith('Painel de fila não pôde ser atualizado após mutação concluída.');
  });
});