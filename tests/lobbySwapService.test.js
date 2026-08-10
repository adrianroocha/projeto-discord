const {
  createTestContext,
  getDb,
  insertLobby,
  insertLobbyPlayer,
  seedQueueEntry,
} = require('./helpers/testDatabase');

describe('lobby swap service', () => {
  let context;
  let db;

  function seedBaseScenario({ aIsSubscriber, bIsSubscriber }) {
    insertLobby(db, {
      id: 10,
      lobbyNumber: 3,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 20_000,
    });

    db.prepare(
      `INSERT INTO lobby_players (
        id,
        lobby_id,
        discord_id,
        username,
        display_name,
        position,
        original_joined_at_ms,
        original_queue_order_key,
        is_subscriber
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      100,
      10,
      'user-a',
      'User A#0001',
      'User A',
      2,
      10_000,
      120,
      aIsSubscriber ? 1 : 0,
    );

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
      isSubscriber: bIsSubscriber ? 1 : 0,
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

    db.prepare(
      'INSERT INTO queue_priority_snapshots (cycle_id, discord_id, is_subscriber, created_at_ms) VALUES (?, ?, ?, ?)',
    ).run(1, 'user-a', aIsSubscriber ? 1 : 0, 10_000);
    db.prepare(
      'INSERT INTO queue_priority_snapshots (cycle_id, discord_id, is_subscriber, created_at_ms) VALUES (?, ?, ?, ?)',
    ).run(1, 'user-b', bIsSubscriber ? 1 : 0, 16_000);
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-10T10:00:00.000Z'));

    context = await createTestContext({ nodeEnv: 'test' });
    db = getDb(context.sqliteClient);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await context.cleanup();
  });

  test.each([
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ])(
    'troca preserva slot e posição absoluta (A sub=%i, B sub=%i)',
    (aIsSubscriber, bIsSubscriber) => {
      seedBaseScenario({ aIsSubscriber, bIsSubscriber });
      const beforeSnapshots = db
        .prepare('SELECT cycle_id, discord_id, is_subscriber, created_at_ms FROM queue_priority_snapshots ORDER BY cycle_id, discord_id')
        .all();

      const emitSpy = jest.spyOn(context.queueEvents, 'emit');
      const result = context.queueService.swapLobbyPlayerWithQueuePlayer({
        lobbyDiscordId: 'user-a',
        queueDiscordId: 'user-b',
        reason: 'troca combinada',
      });

      expect(result.success).toBe(true);
      expect(result.lobbyNumber).toBe(3);
      expect(result.slot).toBe(2);

      const lobbySlot = db
        .prepare('SELECT discord_id, is_subscriber, original_joined_at_ms, original_queue_order_key FROM lobby_players WHERE lobby_id = ? AND position = ?')
        .get(10, 2);
      expect(lobbySlot.discord_id).toBe('user-b');
      expect(lobbySlot.is_subscriber).toBe(bIsSubscriber ? 1 : 0);
      expect(lobbySlot.original_joined_at_ms).toBe(16_000);
      expect(lobbySlot.original_queue_order_key).toBe(200);

      const queueRowA = db
        .prepare(
          `SELECT discord_id, is_subscriber, joined_at_ms, queue_order_key, admin_sort_priority_override
           FROM queue_entries
           WHERE discord_id = ?`,
        )
        .get('user-a');
      expect(queueRowA.is_subscriber).toBe(aIsSubscriber ? 1 : 0);
      expect(queueRowA.joined_at_ms).toBe(10_000);
      expect(queueRowA.queue_order_key).toBe(200);
      expect(queueRowA.admin_sort_priority_override).toBe(bIsSubscriber ? 1 : 0);

      const queueOrder = context.queueService.getQueue().map((row) => row.discord_id);
      expect(queueOrder.includes('user-b')).toBe(false);
      const expectedPosition = bIsSubscriber ? 0 : 1;
      expect(queueOrder.indexOf('user-a')).toBe(expectedPosition);

      const lock = db.prepare('SELECT rebuild_locked FROM lobbies WHERE id = 10').get();
      expect(lock.rebuild_locked).toBe(1);

      const afterSnapshots = db
        .prepare('SELECT cycle_id, discord_id, is_subscriber, created_at_ms FROM queue_priority_snapshots ORDER BY cycle_id, discord_id')
        .all();
      expect(afterSnapshots).toEqual(beforeSnapshots);

      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenLastCalledWith('queueUpdated');
    },
  );

  test('cooldown permanece coerente após troca', () => {
    seedBaseScenario({ aIsSubscriber: 0, bIsSubscriber: 1 });

    const beforeA = context.queueService.getLeaveCooldown('user-a');
    const beforeB = context.queueService.getLeaveCooldown('user-b');

    const result = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'user-a',
      queueDiscordId: 'user-b',
      reason: 'troca combinada',
    });

    expect(result.success).toBe(true);

    const afterA = context.queueService.getLeaveCooldown('user-a');
    const afterB = context.queueService.getLeaveCooldown('user-b');

    expect(afterA.remainingSeconds).toBe(beforeA.remainingSeconds);
    expect(afterB.remainingSeconds).toBe(beforeB.remainingSeconds);
  });

  test('recusa troca quando A e B são iguais', () => {
    const result = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'same-user',
      queueDiscordId: 'same-user',
      reason: 'x',
    });

    expect(result).toEqual({ success: false, reason: 'SAME_USER' });
  });

  test('recusa quando A não está em forming', () => {
    seedQueueEntry(db, {
      id: 1,
      discordId: 'user-b',
      username: 'User B#0001',
      displayName: 'User B',
      isSubscriber: 0,
      joinedAtMs: 16_000,
      queueOrderKey: 200,
    });

    const result = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'user-a',
      queueDiscordId: 'user-b',
      reason: 'troca combinada',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('LOBBY_PLAYER_NOT_FOUND');
  });

  test('recusa quando B não está na fila', () => {
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

    const result = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'user-a',
      queueDiscordId: 'user-b',
      reason: 'troca combinada',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('QUEUE_PLAYER_NOT_FOUND');
  });

  test('lobby in_game é imutável', () => {
    insertLobby(db, {
      id: 99,
      lobbyNumber: 99,
      status: 'in_game',
      creationType: 'automatic',
      createdAtMs: 40_000,
    });
    insertLobbyPlayer(db, {
      id: 900,
      lobbyId: 99,
      discordId: 'user-a',
      username: 'User A#0001',
      displayName: 'User A',
      position: 1,
      originalJoinedAtMs: 39_000,
      isSubscriber: 0,
    });
    seedQueueEntry(db, {
      id: 1,
      discordId: 'user-b',
      username: 'User B#0001',
      displayName: 'User B',
      isSubscriber: 0,
      joinedAtMs: 16_000,
      queueOrderKey: 200,
    });

    const result = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'user-a',
      queueDiscordId: 'user-b',
      reason: 'troca combinada',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('LOBBY_IMMUTABLE');
  });

  test('recusa quando B já está em outra lobby forming', () => {
    seedBaseScenario({ aIsSubscriber: 0, bIsSubscriber: 0 });

    insertLobby(db, {
      id: 11,
      lobbyNumber: 4,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 25_000,
    });
    insertLobbyPlayer(db, {
      id: 111,
      lobbyId: 11,
      discordId: 'user-b',
      username: 'User B#0001',
      displayName: 'User B',
      position: 1,
      originalJoinedAtMs: 16_000,
      isSubscriber: 0,
    });

    const result = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'user-a',
      queueDiscordId: 'user-b',
      reason: 'troca combinada',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('PLAYER_ALREADY_IN_FORMING_LOBBY');
  });

  test('recusa quando A já está na fila', () => {
    seedBaseScenario({ aIsSubscriber: 0, bIsSubscriber: 0 });

    seedQueueEntry(db, {
      id: 99,
      discordId: 'user-a',
      username: 'User A#0001',
      displayName: 'User A',
      isSubscriber: 0,
      joinedAtMs: 19_000,
      queueOrderKey: 350,
    });

    const result = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'user-a',
      queueDiscordId: 'user-b',
      reason: 'troca combinada',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('PLAYER_ALREADY_IN_QUEUE');
  });

  test('rollback total em falha transacional injetada', () => {
    seedBaseScenario({ aIsSubscriber: 0, bIsSubscriber: 0 });

    const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key').all();
    const beforeLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position').all();

    const realPrepare = db.prepare.bind(db);
    jest.spyOn(db, 'prepare').mockImplementation((sql) => {
      const stmt = realPrepare(sql);
      if (String(sql).includes('UPDATE lobbies SET rebuild_locked = 1')) {
        return {
          run: () => {
            throw new Error('forced transaction failure');
          },
        };
      }
      return stmt;
    });

    const result = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'user-a',
      queueDiscordId: 'user-b',
      reason: 'troca combinada',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('SWAP_TRANSACTION_FAILED');

    const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key').all();
    const afterLobby = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position').all();

    expect(afterQueue).toEqual(beforeQueue);
    expect(afterLobby).toEqual(beforeLobby);
  });

  test('remove jogador de lobby bloqueada, desbloqueia e permite rebuild normal', () => {
    seedBaseScenario({ aIsSubscriber: 0, bIsSubscriber: 0 });

    const swapped = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'user-a',
      queueDiscordId: 'user-b',
      reason: 'troca combinada',
    });
    expect(swapped.success).toBe(true);

    jest.setSystemTime(new Date('2026-08-10T10:10:00.000Z'));
    const removed = context.queueService.removeFromQueue('user-b');
    expect(removed.success).toBe(true);
    expect(removed.removedFromLocked).toBeGreaterThan(0);

    const lock = db.prepare('SELECT rebuild_locked FROM lobbies WHERE id = 10').get();
    if (lock) {
      expect(lock.rebuild_locked).toBe(0);
    } else {
      const remainingPlayers = db.prepare('SELECT COUNT(1) AS count FROM lobby_players WHERE lobby_id = 10').get();
      expect(remainingPlayers.count).toBe(0);
    }
  });

  test('saída de A da fila remove override e reentrada volta ao padrão', () => {
    seedBaseScenario({ aIsSubscriber: 0, bIsSubscriber: 1 });

    const swapped = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'user-a',
      queueDiscordId: 'user-b',
      reason: 'troca combinada',
    });
    expect(swapped.success).toBe(true);

    jest.setSystemTime(new Date('2026-08-10T10:10:00.000Z'));
    const removed = context.queueService.removeFromQueue('user-a');
    expect(removed.success).toBe(true);

    const removedRow = db.prepare('SELECT discord_id FROM queue_entries WHERE discord_id = ?').get('user-a');
    expect(removedRow).toBeUndefined();

    const rejoin = context.queueService.addToQueue({
      discordId: 'user-a',
      username: 'User A#0001',
      displayName: 'User A',
      isSubscriber: 0,
    });
    expect(rejoin.success).toBe(true);

    const rejoinedRow = db
      .prepare('SELECT queue_order_key, admin_sort_priority_override FROM queue_entries WHERE discord_id = ?')
      .get('user-a');

    expect(rejoinedRow.admin_sort_priority_override).toBeNull();
    expect(Number.isSafeInteger(rejoinedRow.queue_order_key)).toBe(true);
    expect(rejoinedRow.queue_order_key).toBeGreaterThan(0);
  });

  test('rebuild ignora lobby bloqueada e não desfaz troca em entrada de terceiro', () => {
    seedBaseScenario({ aIsSubscriber: 1, bIsSubscriber: 0 });

    const swapped = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'user-a',
      queueDiscordId: 'user-b',
      reason: 'troca combinada',
    });
    expect(swapped.success).toBe(true);

    context.queueService.addToQueue({
      discordId: 'late-player',
      username: 'Late Player#0001',
      displayName: 'Late Player',
      isSubscriber: 1,
    });

    const lobbySlot = db
      .prepare('SELECT discord_id FROM lobby_players WHERE lobby_id = ? AND position = ?')
      .get(10, 2);

    expect(lobbySlot.discord_id).toBe('user-b');
  });
});
