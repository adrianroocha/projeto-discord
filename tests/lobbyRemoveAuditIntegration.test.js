const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const {
  createTestContext,
  getDb,
  insertLobby,
  insertLobbyPlayer,
  seedQueueEntry,
} = require('./helpers/testDatabase');

function seedRemoveScenario(db, { targetId = 'target-user', lobbyStatus = 'forming', creationType = 'automatic' } = {}) {
  insertLobby(db, {
    id: 10,
    lobbyNumber: 3,
    status: lobbyStatus,
    creationType,
    createdAtMs: 20_000,
  });

  insertLobbyPlayer(db, {
    id: 100,
    lobbyId: 10,
    discordId: targetId,
    username: 'Target#0001',
    displayName: 'Target',
    position: 2,
    originalJoinedAtMs: 10_000,
    isSubscriber: 0,
  });

  insertLobbyPlayer(db, {
    id: 101,
    lobbyId: 10,
    discordId: 'player-c',
    username: 'Player C#0001',
    displayName: 'Player C',
    position: 1,
    originalJoinedAtMs: 9_000,
    isSubscriber: 0,
  });

  insertLobbyPlayer(db, {
    id: 102,
    lobbyId: 10,
    discordId: 'player-d',
    username: 'Player D#0001',
    displayName: 'Player D',
    position: 3,
    originalJoinedAtMs: 11_000,
    isSubscriber: 0,
  });

  insertLobbyPlayer(db, {
    id: 103,
    lobbyId: 10,
    discordId: 'player-e',
    username: 'Player E#0001',
    displayName: 'Player E',
    position: 4,
    originalJoinedAtMs: 12_000,
    isSubscriber: 1,
  });

  seedQueueEntry(db, {
    id: 1,
    discordId: 'queue-fill',
    username: 'Queue Fill#0001',
    displayName: 'Queue Fill',
    isSubscriber: 1,
    joinedAtMs: 13_000,
    queueOrderKey: 150,
  });

  seedQueueEntry(db, {
    id: 2,
    discordId: targetId,
    username: 'Target#0001',
    displayName: 'Target',
    isSubscriber: 0,
    joinedAtMs: 16_000,
    queueOrderKey: 200,
    adminSortPriorityOverride: 1,
  });
}

function makeInteraction({
  id = 'interaction-remove-1',
  actorId = 'moderator-1',
  actorFlags = [PermissionFlagsBits.ManageGuild],
  actorRoleIds = [],
  unavailableIds = [],
  targetUserId = 'target-user',
  reason = 'Jogador ausente',
  client = {},
}) {
  const unavailableSet = new Set(unavailableIds);

  return {
    id,
    commandName: 'lobby-remove',
    guildId: 'test-guild',
    channelId: 'channel-1',
    inGuild: () => true,
    user: { id: actorId, username: 'moderator' },
    guild: {
      members: {
        fetch: jest.fn(async (discordId) => {
          if (unavailableSet.has(discordId)) {
            throw new Error('member unavailable');
          }

          if (discordId === actorId) {
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
          }

          return {
            id: discordId,
            permissions: {
              has: () => false,
            },
            roles: {
              cache: {
                has: () => false,
              },
            },
          };
        }),
      },
    },
    options: {
      getUser: jest.fn().mockImplementation((name) => {
        if (name === 'usuario') {
          return targetUserId ? { id: targetUserId } : null;
        }

        return null;
      }),
      getString: jest.fn().mockImplementation((name) => (name === 'motivo' ? reason : null)),
    },
    client,
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('/lobby-remove audit integration', () => {
  let context;
  let db;
  let command;
  let auditRepository;
  let queueEvents;

  beforeEach(async () => {
    context = await createTestContext({
      nodeEnv: 'test',
      botOperatorRoleIds: '',
    });

    db = getDb(context.sqliteClient);
    command = require('../src/commands/lobbyRemove');
    auditRepository = require('../src/database/adminCommandAuditLogsRepository');
    queueEvents = context.queueEvents;
  });

  afterEach(async () => {
    queueEvents.removeAllListeners('queueUpdated');
    await context.cleanup();
  });

  test('success: aplica remoção, não retorna para fila, audita success OK e emite queueUpdated uma vez', async () => {
    seedRemoveScenario(db);
    const emitSpy = jest.spyOn(queueEvents, 'emit');

    const interaction = makeInteraction({
      id: 'interaction-success',
      actorFlags: [PermissionFlagsBits.ManageGuild],
    });

    await command.execute(interaction);

    const lobbyRow = db.prepare('SELECT id FROM lobby_players WHERE discord_id = ?').get('target-user');
    const queueRow = db.prepare('SELECT id FROM queue_entries WHERE discord_id = ?').get('target-user');

    expect(lobbyRow).toBeUndefined();
    expect(queueRow).toBeUndefined();

    const latest = auditRepository.findLatest();
    expect(latest.commandName).toBe('lobby-remove');
    expect(latest.result).toBe('success');
    expect(latest.errorCode).toBe('OK');
    expect(latest.parametersJson).toContain('"usuario":"target-user"');
    expect(latest.parametersJson).toContain('"motivo":"Jogador ausente"');
    expect(latest.parametersJson).not.toMatch(/token|payload|stack|exception|secret/i);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('queueUpdated');
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('denied: usuário comum não muta e audita denied', async () => {
    seedRemoveScenario(db);

    const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const beforeLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position ASC').all();

    const interaction = makeInteraction({
      id: 'interaction-denied',
      actorFlags: [],
      actorRoleIds: ['1304992476536508516'],
    });

    await command.execute(interaction);

    const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const afterLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position ASC').all();

    expect(afterQueue).toEqual(beforeQueue);
    expect(afterLobby).toEqual(beforeLobby);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('denied');
    expect(latest.errorCode).toBe('MISSING_PERMISSION');
    expect(interaction.reply.mock.calls[0][0].content).not.toContain('1304992476536508516');
  });

  test('denied: membro real do ator indisponível falha com MEMBER_UNAVAILABLE', async () => {
    seedRemoveScenario(db);

    const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const beforeLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position ASC').all();

    const interaction = makeInteraction({
      id: 'interaction-member-unavailable',
      actorId: 'moderator-unavailable',
      actorFlags: [PermissionFlagsBits.ManageGuild],
      unavailableIds: ['moderator-unavailable'],
    });

    await command.execute(interaction);

    const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const afterLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position ASC').all();

    expect(afterQueue).toEqual(beforeQueue);
    expect(afterLobby).toEqual(beforeLobby);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('denied');
    expect(latest.errorCode).toBe('MEMBER_UNAVAILABLE');
  });

  test('failed: target fora de lobby removível retorna not found sem mutação', async () => {
    seedQueueEntry(db, {
      id: 1,
      discordId: 'target-user',
      username: 'Target#0001',
      displayName: 'Target',
      isSubscriber: 0,
      joinedAtMs: 16_000,
      queueOrderKey: 200,
    });

    const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const beforeLobby = db.prepare('SELECT discord_id, position FROM lobby_players ORDER BY id ASC').all();

    const interaction = makeInteraction({
      id: 'interaction-failed-not-found',
      actorFlags: [PermissionFlagsBits.Administrator],
      targetUserId: 'target-user',
    });

    await command.execute(interaction);

    const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const afterLobby = db.prepare('SELECT discord_id, position FROM lobby_players ORDER BY id ASC').all();

    expect(afterQueue).toEqual(beforeQueue);
    expect(afterLobby).toEqual(beforeLobby);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('failed');
    expect(latest.errorCode).toBe('LOBBY_PLAYER_NOT_FOUND');
  });

  test('failed: lobby in_game é imutável e auditada sem mutação', async () => {
    seedRemoveScenario(db, { lobbyStatus: 'in_game' });

    const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const beforeLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position ASC').all();

    const interaction = makeInteraction({
      id: 'interaction-failed-in-game',
      actorFlags: [PermissionFlagsBits.Administrator],
    });

    await command.execute(interaction);

    const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const afterLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position ASC').all();

    expect(afterQueue).toEqual(beforeQueue);
    expect(afterLobby).toEqual(beforeLobby);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('failed');
    expect(latest.errorCode).toBe('LOBBY_IMMUTABLE');
  });

  test('auditoria inicial indisponível bloqueia mutação', async () => {
    seedRemoveScenario(db);

    const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const beforeLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position ASC').all();

    const adminCommandAuditService = require('../src/services/adminCommandAuditService');
    const beginSpy = jest
      .spyOn(adminCommandAuditService, 'beginRequired')
      .mockRejectedValueOnce(new Error('sqlite unavailable'));

    const interaction = makeInteraction({
      id: 'interaction-audit-unavailable',
      actorFlags: [PermissionFlagsBits.ManageGuild],
    });

    await command.execute(interaction);
    beginSpy.mockRestore();

    const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const afterLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position ASC').all();

    expect(afterQueue).toEqual(beforeQueue);
    expect(afterLobby).toEqual(beforeLobby);
    expect(auditRepository.countAll()).toBe(0);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('idempotência: mesma interaction_id remove uma vez e mantém uma única auditoria', async () => {
    seedRemoveScenario(db);

    const interaction = makeInteraction({
      id: 'interaction-idempotent',
      actorFlags: [PermissionFlagsBits.ManageGuild],
    });

    await command.execute(interaction);

    const queueAfterFirst = db
      .prepare('SELECT discord_id FROM queue_entries ORDER BY COALESCE(queue_order_key, joined_at_ms), discord_id')
      .all();

    await command.execute(interaction);

    const queueAfterSecond = db
      .prepare('SELECT discord_id FROM queue_entries ORDER BY COALESCE(queue_order_key, joined_at_ms), discord_id')
      .all();

    const auditsCount = auditRepository.countAll();
    const latest = auditRepository.findLatest();

    expect(queueAfterSecond).toEqual(queueAfterFirst);
    expect(auditsCount).toBe(1);
    expect(latest.result).toBe('success');
    expect(interaction.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: 'Esta interação já foi processada anteriormente.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('alvo indisponível no Discord não impede remoção quando discord_id é conhecido', async () => {
    seedRemoveScenario(db);

    const interaction = makeInteraction({
      id: 'interaction-target-offline',
      actorFlags: [PermissionFlagsBits.ManageGuild],
      unavailableIds: ['target-user'],
      targetUserId: 'target-user',
    });

    await command.execute(interaction);

    const fetchCalls = interaction.guild.members.fetch.mock.calls.map((args) => args[0]);
    expect(fetchCalls).toEqual(['moderator-1']);
    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('success');
    expect(latest.parametersJson).not.toMatch(/payload|token|stack|secret|1304992476536508516/i);
  });

  test('cargo operacional configurado permite execução sem ManageGuild/Administrator', async () => {
    await context.cleanup();

    context = await createTestContext({
      nodeEnv: 'test',
      botOperatorRoleIds: '900000000000000001',
    });

    db = getDb(context.sqliteClient);
    command = require('../src/commands/lobbyRemove');
    auditRepository = require('../src/database/adminCommandAuditLogsRepository');
    queueEvents = context.queueEvents;

    seedRemoveScenario(db);

    const interaction = makeInteraction({
      id: 'interaction-operator-role',
      actorFlags: [],
      actorRoleIds: ['900000000000000001'],
    });

    await command.execute(interaction);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('success');
    expect(latest.errorCode).toBe('OK');
  });
});
