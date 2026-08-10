const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const {
  createTestContext,
  getDb,
  insertLobby,
  insertLobbyPlayer,
  seedQueueEntry,
} = require('./helpers/testDatabase');

function seedSwapScenario(db) {
  insertLobby(db, {
    id: 10,
    lobbyNumber: 3,
    status: 'forming',
    creationType: 'automatic',
    createdAtMs: 20_000,
  });

  insertLobbyPlayer(db, {
    id: 100,
    lobbyId: 10,
    discordId: 'user-a',
    username: 'User A#0001',
    displayName: 'User A',
    position: 2,
    originalJoinedAtMs: 10_000,
    isSubscriber: 0,
  });

  insertLobbyPlayer(db, {
    id: 101,
    lobbyId: 10,
    discordId: 'user-c',
    username: 'User C#0001',
    displayName: 'User C',
    position: 1,
    originalJoinedAtMs: 9_000,
    isSubscriber: 0,
  });

  seedQueueEntry(db, {
    id: 1,
    discordId: 'queue-before',
    username: 'Queue Before#0001',
    displayName: 'Queue Before',
    isSubscriber: 0,
    joinedAtMs: 15_000,
    queueOrderKey: 110,
  });

  seedQueueEntry(db, {
    id: 2,
    discordId: 'user-b',
    username: 'User B#0001',
    displayName: 'User B',
    isSubscriber: 1,
    joinedAtMs: 16_000,
    queueOrderKey: 200,
  });

  seedQueueEntry(db, {
    id: 3,
    discordId: 'queue-after',
    username: 'Queue After#0001',
    displayName: 'Queue After',
    isSubscriber: 0,
    joinedAtMs: 17_000,
    queueOrderKey: 300,
  });
}

function makeInteraction({
  id = 'interaction-swap-1',
  actorId = 'moderator-1',
  actorFlags = [PermissionFlagsBits.ManageGuild],
  actorRoleIds = [],
  unavailableIds = [],
  lobbyUserId = 'user-a',
  queueUserId = 'user-b',
  reason = 'troca validada',
  client = {},
}) {
  const unavailableSet = new Set(unavailableIds);

  return {
    id,
    commandName: 'lobby-swap',
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
        if (name === 'usuario_lobby') {
          return { id: lobbyUserId };
        }

        if (name === 'usuario_fila') {
          return { id: queueUserId };
        }

        return null;
      }),
      getString: jest.fn().mockImplementation((name) => (name === 'motivo' ? reason : null)),
    },
    client,
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('/lobby-swap audit integration', () => {
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
    command = require('../src/commands/lobbySwap');
    auditRepository = require('../src/database/adminCommandAuditLogsRepository');
    queueEvents = context.queueEvents;
  });

  afterEach(async () => {
    queueEvents.removeAllListeners('queueUpdated');
    await context.cleanup();
  });

  test('success: aplica swap, audita success OK e emite queueUpdated uma vez', async () => {
    seedSwapScenario(db);
    const emitSpy = jest.spyOn(queueEvents, 'emit');

    const interaction = makeInteraction({
      id: 'interaction-success',
      actorFlags: [PermissionFlagsBits.ManageGuild],
    });

    await command.execute(interaction);

    const lobbySlot = db
      .prepare('SELECT discord_id, original_queue_order_key FROM lobby_players WHERE lobby_id = ? AND position = ?')
      .get(10, 2);
    expect(lobbySlot.discord_id).toBe('user-b');
    expect(lobbySlot.original_queue_order_key).toBe(200);

    const queueRowA = db
      .prepare('SELECT discord_id, queue_order_key, admin_sort_priority_override FROM queue_entries WHERE discord_id = ?')
      .get('user-a');
    expect(queueRowA.queue_order_key).toBe(200);
    expect(queueRowA.admin_sort_priority_override).toBe(1);

    const latest = auditRepository.findLatest();
    expect(latest.commandName).toBe('lobby-swap');
    expect(latest.result).toBe('success');
    expect(latest.errorCode).toBe('OK');
    expect(latest.parametersJson).toContain('"usuario_lobby":"user-a"');
    expect(latest.parametersJson).toContain('"usuario_fila":"user-b"');
    expect(latest.parametersJson).not.toMatch(/token|payload|stack|exception/i);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('queueUpdated');
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('denied: usuário comum (incluindo cargo sem BOT_OPERATOR_ROLE_IDS) não muta e audita denied', async () => {
    seedSwapScenario(db);

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

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(interaction.reply.mock.calls[0][0].content).not.toContain('1304992476536508516');
  });

  test('denied: membro real do ator indisponível falha com MEMBER_UNAVAILABLE', async () => {
    seedSwapScenario(db);

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

  test('failed: input inválido não gera mutação parcial e audita failed seguro', async () => {
    seedSwapScenario(db);

    const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const beforeLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position ASC').all();

    const interaction = makeInteraction({
      id: 'interaction-failed',
      actorFlags: [PermissionFlagsBits.Administrator],
      lobbyUserId: 'user-a',
      queueUserId: 'user-a',
      reason: 'troca invalida',
    });

    await command.execute(interaction);

    const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC').all();
    const afterLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position ASC').all();

    expect(afterQueue).toEqual(beforeQueue);
    expect(afterLobby).toEqual(beforeLobby);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('failed');
    expect(latest.errorCode).toBe('SAME_USER');
  });

  test('auditoria indisponível: beginRequired falha e bloqueia mutação', async () => {
    seedSwapScenario(db);

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

    const count = auditRepository.countAll();
    expect(count).toBe(0);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('idempotência: mesma interaction_id executa mutação uma vez e mantém uma auditoria', async () => {
    seedSwapScenario(db);

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

  test('cargo operacional configurado permite execução sem ManageGuild/Administrator', async () => {
    await context.cleanup();

    context = await createTestContext({
      nodeEnv: 'test',
      botOperatorRoleIds: '900000000000000001',
    });

    db = getDb(context.sqliteClient);
    command = require('../src/commands/lobbySwap');
    auditRepository = require('../src/database/adminCommandAuditLogsRepository');
    queueEvents = context.queueEvents;

    seedSwapScenario(db);

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

  test('administrator continua autorizado', async () => {
    seedSwapScenario(db);

    const interaction = makeInteraction({
      id: 'interaction-admin-success',
      actorFlags: [PermissionFlagsBits.Administrator],
      actorRoleIds: [],
    });

    await command.execute(interaction);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('success');
    expect(latest.errorCode).toBe('OK');
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
      }),
    );
  });
});
