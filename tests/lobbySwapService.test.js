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
      expect(result.userA.origin.state).toBe('forming_lobby');
      expect(result.userA.destination.state).toBe('queue');
      expect(result.userB.origin.state).toBe('queue');
      expect(result.userB.destination.state).toBe('forming_lobby');
      expect(result.affectedLobbyNumbers).toEqual([3]);
      expect(result.lockedLobbyNumbers).toEqual([3]);

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
      const expectedOverride = (aIsSubscriber ? 1 : 0) === (bIsSubscriber ? 1 : 0) ? null : bIsSubscriber ? 1 : 0;
      expect(queueRowA.admin_sort_priority_override).toBe(expectedOverride);

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
      reason: 'motivo valido',
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
    expect(result.reason).toBe('PARTICIPANT_NOT_FOUND');
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
    expect(result.reason).toBe('PARTICIPANT_NOT_FOUND');
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
    expect(result.reason).toBe('LOBBY_STATE_CONFLICT');
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
    expect(result.reason).toBe('LOBBY_STATE_CONFLICT');
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

  test('permite troca fila <-> fila com posições absolutas trocadas e sem criar lobby', () => {
    seedQueueEntry(db, {
      id: 1,
      discordId: 'user-a',
      username: 'User A#0001',
      displayName: 'User A',
      isSubscriber: 0,
      joinedAtMs: 15_000,
      queueOrderKey: 110,
    });
    seedQueueEntry(db, {
      id: 2,
      discordId: 'user-b',
      username: 'User B#0001',
      displayName: 'User B',
      isSubscriber: 0,
      joinedAtMs: 16_000,
      queueOrderKey: 220,
    });
    seedQueueEntry(db, {
      id: 3,
      discordId: 'user-c',
      username: 'User C#0001',
      displayName: 'User C',
      isSubscriber: 0,
      joinedAtMs: 17_000,
      queueOrderKey: 330,
    });

    const emitSpy = jest.spyOn(context.queueEvents, 'emit');
    const result = context.queueService.swapParticipantsInCurrentCycle({
      discordIdA: 'user-a',
      discordIdB: 'user-b',
      reason: 'troca de fila',
    });

    expect(result.success).toBe(true);
    expect(result.userA.origin.state).toBe('queue');
    expect(result.userA.destination.state).toBe('queue');
    expect(result.userB.origin.state).toBe('queue');
    expect(result.userB.destination.state).toBe('queue');

    const rowA = db
      .prepare('SELECT queue_order_key, joined_at_ms, admin_sort_priority_override FROM queue_entries WHERE discord_id = ?')
      .get('user-a');
    const rowB = db
      .prepare('SELECT queue_order_key, joined_at_ms, admin_sort_priority_override FROM queue_entries WHERE discord_id = ?')
      .get('user-b');

    expect(rowA.queue_order_key).toBe(220);
    expect(rowB.queue_order_key).toBe(110);
    expect(rowA.joined_at_ms).toBe(15_000);
    expect(rowB.joined_at_ms).toBe(16_000);
    expect(rowA.admin_sort_priority_override).toBeNull();
    expect(rowB.admin_sort_priority_override).toBeNull();

    const lobbiesCount = db.prepare('SELECT COUNT(1) AS count FROM lobbies').get().count;
    expect(lobbiesCount).toBe(0);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  test('fila <-> fila com prioridades diferentes aplica override somente quando necessário', () => {
    seedQueueEntry(db, {
      id: 1,
      discordId: 'user-a',
      username: 'User A#0001',
      displayName: 'User A',
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
      queueOrderKey: 220,
    });

    const result = context.queueService.swapParticipantsInCurrentCycle({
      discordIdA: 'user-a',
      discordIdB: 'user-b',
      reason: 'troca de prioridade',
    });
    expect(result.success).toBe(true);

    const rowA = db
      .prepare('SELECT queue_order_key, admin_sort_priority_override FROM queue_entries WHERE discord_id = ?')
      .get('user-a');
    const rowB = db
      .prepare('SELECT queue_order_key, admin_sort_priority_override FROM queue_entries WHERE discord_id = ?')
      .get('user-b');

    expect(rowA.queue_order_key).toBe(220);
    expect(rowB.queue_order_key).toBe(110);
    expect(rowA.admin_sort_priority_override).toBe(1);
    expect(rowB.admin_sort_priority_override).toBe(0);

    jest.setSystemTime(new Date('2026-08-10T10:10:00.000Z'));
    const removed = context.queueService.removeFromQueue('user-a');
    expect(removed.success).toBe(true);
    expect(db.prepare('SELECT id FROM queue_entries WHERE discord_id = ?').get('user-a')).toBeUndefined();

    const rejoin = context.queueService.addToQueue({
      discordId: 'user-a',
      username: 'User A#0001',
      displayName: 'User A',
      isSubscriber: 0,
    });
    expect(rejoin.success).toBe(true);

    const rejoinedRow = db
      .prepare('SELECT admin_sort_priority_override FROM queue_entries WHERE discord_id = ?')
      .get('user-a');
    expect(rejoinedRow.admin_sort_priority_override).toBeNull();
  });

  test('permite forming <-> forming entre lobbies diferentes e trava ambas para rebuild', () => {
    insertLobby(db, {
      id: 10,
      lobbyNumber: 1,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 20_000,
    });
    insertLobby(db, {
      id: 20,
      lobbyNumber: 2,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 20_100,
    });

    insertLobbyPlayer(db, {
      id: 101,
      lobbyId: 10,
      discordId: 'user-a',
      username: 'User A#0001',
      displayName: 'User A',
      position: 1,
      originalJoinedAtMs: 10_000,
      isSubscriber: 0,
    });
    insertLobbyPlayer(db, {
      id: 102,
      lobbyId: 10,
      discordId: 'user-x',
      username: 'User X#0001',
      displayName: 'User X',
      position: 2,
      originalJoinedAtMs: 10_500,
      isSubscriber: 1,
    });
    insertLobbyPlayer(db, {
      id: 201,
      lobbyId: 20,
      discordId: 'user-b',
      username: 'User B#0001',
      displayName: 'User B',
      position: 2,
      originalJoinedAtMs: 12_000,
      isSubscriber: 1,
    });
    insertLobbyPlayer(db, {
      id: 202,
      lobbyId: 20,
      discordId: 'user-y',
      username: 'User Y#0001',
      displayName: 'User Y',
      position: 1,
      originalJoinedAtMs: 11_000,
      isSubscriber: 0,
    });

    const result = context.queueService.swapParticipantsInCurrentCycle({
      discordIdA: 'user-a',
      discordIdB: 'user-b',
      reason: 'troca entre lobbies',
    });

    expect(result.success).toBe(true);
    expect(result.affectedLobbyNumbers.sort((a, b) => a - b)).toEqual([1, 2]);

    const slotA = db.prepare('SELECT discord_id FROM lobby_players WHERE lobby_id = ? AND position = ?').get(10, 1);
    const slotB = db.prepare('SELECT discord_id FROM lobby_players WHERE lobby_id = ? AND position = ?').get(20, 2);
    expect(slotA.discord_id).toBe('user-b');
    expect(slotB.discord_id).toBe('user-a');

    const queueCount = db.prepare('SELECT COUNT(1) AS count FROM queue_entries').get().count;
    expect(queueCount).toBe(0);

    const lockRows = db.prepare('SELECT id, rebuild_locked FROM lobbies ORDER BY id').all();
    expect(lockRows).toEqual([
      { id: 10, rebuild_locked: 1 },
      { id: 20, rebuild_locked: 1 },
    ]);
  });

  test('permite forming <-> forming na mesma lobby sem lock duplicado nem evento duplicado', () => {
    insertLobby(db, {
      id: 10,
      lobbyNumber: 1,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 20_000,
    });
    insertLobbyPlayer(db, {
      id: 101,
      lobbyId: 10,
      discordId: 'user-a',
      username: 'User A#0001',
      displayName: 'User A',
      position: 1,
      originalJoinedAtMs: 10_000,
      isSubscriber: 0,
    });
    insertLobbyPlayer(db, {
      id: 102,
      lobbyId: 10,
      discordId: 'user-b',
      username: 'User B#0001',
      displayName: 'User B',
      position: 2,
      originalJoinedAtMs: 11_000,
      isSubscriber: 1,
    });

    const emitSpy = jest.spyOn(context.queueEvents, 'emit');
    const result = context.queueService.swapParticipantsInCurrentCycle({
      discordIdA: 'user-a',
      discordIdB: 'user-b',
      reason: 'troca interna',
    });

    expect(result.success).toBe(true);
    expect(result.lockedLobbyIds).toEqual([10]);

    const slot1 = db.prepare('SELECT discord_id FROM lobby_players WHERE lobby_id = ? AND position = ?').get(10, 1);
    const slot2 = db.prepare('SELECT discord_id FROM lobby_players WHERE lobby_id = ? AND position = ?').get(10, 2);
    expect(slot1.discord_id).toBe('user-b');
    expect(slot2.discord_id).toBe('user-a');
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  test('lobby in_game de B também torna a troca proibida sem mover A', () => {
    seedQueueEntry(db, {
      id: 1,
      discordId: 'user-a',
      username: 'User A#0001',
      displayName: 'User A',
      isSubscriber: 0,
      joinedAtMs: 16_000,
      queueOrderKey: 200,
    });
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
      discordId: 'user-b',
      username: 'User B#0001',
      displayName: 'User B',
      position: 1,
      originalJoinedAtMs: 39_000,
      isSubscriber: 0,
    });

    const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key').all();
    const result = context.queueService.swapParticipantsInCurrentCycle({
      discordIdA: 'user-a',
      discordIdB: 'user-b',
      reason: 'troca bloqueada',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('LOBBY_IMMUTABLE');
    const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key').all();
    expect(afterQueue).toEqual(beforeQueue);
  });

  describe('reentrada após in_game não bloqueia participação mutável atual', () => {
    function seedInGameHistory(discordId, { lobbyId, lobbyNumber, position, joinedAtMs }) {
      insertLobby(db, {
        id: lobbyId,
        lobbyNumber,
        status: 'in_game',
        creationType: 'automatic',
        createdAtMs: joinedAtMs - 1_000,
      });
      insertLobbyPlayer(db, {
        id: lobbyId * 10 + position,
        lobbyId,
        discordId,
        username: `${discordId}#0001`,
        displayName: discordId,
        position,
        originalJoinedAtMs: joinedAtMs,
        isSubscriber: 0,
      });
    }

    test('A em in_game, reentra e fica na fila; swap com C na fila funciona', () => {
      seedInGameHistory('user-a', { lobbyId: 50, lobbyNumber: 50, position: 1, joinedAtMs: 5_000 });

      seedQueueEntry(db, {
        id: 1,
        discordId: 'user-a',
        username: 'User A#0001',
        displayName: 'User A',
        isSubscriber: 0,
        joinedAtMs: 20_000,
        queueOrderKey: 110,
      });
      seedQueueEntry(db, {
        id: 2,
        discordId: 'user-c',
        username: 'User C#0001',
        displayName: 'User C',
        isSubscriber: 0,
        joinedAtMs: 21_000,
        queueOrderKey: 220,
      });

      const beforeInGame = db
        .prepare('SELECT discord_id, lobby_id, position FROM lobby_players WHERE lobby_id = 50')
        .all();

      const result = context.queueService.swapParticipantsInCurrentCycle({
        discordIdA: 'user-a',
        discordIdB: 'user-c',
        reason: 'swap após reentrada na fila',
      });

      expect(result.success).toBe(true);
      expect(result.userA.origin.state).toBe('queue');
      expect(result.userB.origin.state).toBe('queue');

      const afterInGame = db
        .prepare('SELECT discord_id, lobby_id, position FROM lobby_players WHERE lobby_id = 50')
        .all();
      expect(afterInGame).toEqual(beforeInGame);

      const rowA = db.prepare('SELECT queue_order_key FROM queue_entries WHERE discord_id = ?').get('user-a');
      expect(rowA.queue_order_key).toBe(220);
    });

    test('A em in_game, reentra e vai para forming; swap com B na fila funciona', () => {
      seedInGameHistory('user-a', { lobbyId: 51, lobbyNumber: 51, position: 1, joinedAtMs: 5_000 });

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
        originalJoinedAtMs: 22_000,
        originalQueueOrderKey: 500,
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

      const beforeInGame = db
        .prepare('SELECT discord_id, lobby_id, position FROM lobby_players WHERE lobby_id = 51')
        .all();

      const result = context.queueService.swapParticipantsInCurrentCycle({
        discordIdA: 'user-a',
        discordIdB: 'user-b',
        reason: 'swap após reentrada em forming',
      });

      expect(result.success).toBe(true);
      expect(result.userA.origin.state).toBe('forming_lobby');
      expect(result.userB.origin.state).toBe('queue');

      const afterInGame = db
        .prepare('SELECT discord_id, lobby_id, position FROM lobby_players WHERE lobby_id = 51')
        .all();
      expect(afterInGame).toEqual(beforeInGame);

      const slot = db
        .prepare('SELECT discord_id FROM lobby_players WHERE lobby_id = ? AND position = ?')
        .get(10, 2);
      expect(slot.discord_id).toBe('user-b');
    });

    test('cenário real: A permanece em in_game e também está em forming #3; B aguardando; swap A<->B preserva lobby ativa e move slot/fila exatos', () => {
      seedInGameHistory('user-a', { lobbyId: 3, lobbyNumber: 1, position: 1, joinedAtMs: 5_000 });

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
        originalJoinedAtMs: 22_000,
        originalQueueOrderKey: 500,
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
        discordId: 'user-b',
        username: 'User B#0001',
        displayName: 'User B',
        isSubscriber: 0,
        joinedAtMs: 16_000,
        queueOrderKey: 200,
      });

      const activeLobbyBefore = db.prepare('SELECT * FROM lobbies WHERE id = 3').get();
      const activeLobbyPlayersBefore = db
        .prepare('SELECT * FROM lobby_players WHERE lobby_id = 3 ORDER BY position')
        .all();

      const emitSpy = jest.spyOn(context.queueEvents, 'emit');
      const result = context.queueService.swapParticipantsInCurrentCycle({
        discordIdA: 'user-a',
        discordIdB: 'user-b',
        reason: 'swap cenario real',
      });

      expect(result.success).toBe(true);

      const activeLobbyAfter = db.prepare('SELECT * FROM lobbies WHERE id = 3').get();
      const activeLobbyPlayersAfter = db
        .prepare('SELECT * FROM lobby_players WHERE lobby_id = 3 ORDER BY position')
        .all();
      expect(activeLobbyAfter).toEqual(activeLobbyBefore);
      expect(activeLobbyPlayersAfter).toEqual(activeLobbyPlayersBefore);

      const formingSlot = db
        .prepare('SELECT discord_id FROM lobby_players WHERE lobby_id = ? AND position = ?')
        .get(10, 2);
      expect(formingSlot.discord_id).toBe('user-b');

      const queueRowA = db.prepare('SELECT queue_order_key FROM queue_entries WHERE discord_id = ?').get('user-a');
      expect(queueRowA.queue_order_key).toBe(200);

      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenLastCalledWith('queueUpdated');
    });

    test('A com uma forming e múltiplos registros in_game continua elegível', () => {
      seedInGameHistory('user-a', { lobbyId: 60, lobbyNumber: 60, position: 1, joinedAtMs: 5_000 });
      seedInGameHistory('user-a', { lobbyId: 61, lobbyNumber: 61, position: 1, joinedAtMs: 6_000 });

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
        position: 1,
        originalJoinedAtMs: 22_000,
        originalQueueOrderKey: 500,
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

      const result = context.queueService.swapParticipantsInCurrentCycle({
        discordIdA: 'user-a',
        discordIdB: 'user-b',
        reason: 'swap com multiplos in_game',
      });

      expect(result.success).toBe(true);
      expect(result.userA.origin.state).toBe('forming_lobby');
    });

    test('usuário somente em in_game continua retornando LOBBY_IMMUTABLE mesmo com histórico único', () => {
      seedInGameHistory('user-a', { lobbyId: 70, lobbyNumber: 70, position: 1, joinedAtMs: 5_000 });
      seedQueueEntry(db, {
        id: 1,
        discordId: 'user-b',
        username: 'User B#0001',
        displayName: 'User B',
        isSubscriber: 0,
        joinedAtMs: 16_000,
        queueOrderKey: 200,
      });

      const emitSpy = jest.spyOn(context.queueEvents, 'emit');
      const result = context.queueService.swapParticipantsInCurrentCycle({
        discordIdA: 'user-a',
        discordIdB: 'user-b',
        reason: 'swap bloqueado',
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe('LOBBY_IMMUTABLE');
      expect(emitSpy).not.toHaveBeenCalled();
    });

    test('fila + forming simultâneos no mesmo usuário retornam LOBBY_STATE_CONFLICT mesmo com histórico in_game', () => {
      seedInGameHistory('user-a', { lobbyId: 80, lobbyNumber: 80, position: 1, joinedAtMs: 5_000 });

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
        position: 1,
        originalJoinedAtMs: 22_000,
        isSubscriber: 0,
      });
      seedQueueEntry(db, {
        id: 1,
        discordId: 'user-a',
        username: 'User A#0001',
        displayName: 'User A',
        isSubscriber: 0,
        joinedAtMs: 23_000,
        queueOrderKey: 350,
      });
      seedQueueEntry(db, {
        id: 2,
        discordId: 'user-b',
        username: 'User B#0001',
        displayName: 'User B',
        isSubscriber: 0,
        joinedAtMs: 16_000,
        queueOrderKey: 200,
      });

      const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key').all();

      const result = context.queueService.swapParticipantsInCurrentCycle({
        discordIdA: 'user-a',
        discordIdB: 'user-b',
        reason: 'swap conflito',
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe('LOBBY_STATE_CONFLICT');

      const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key').all();
      expect(afterQueue).toEqual(beforeQueue);
    });

    test('múltiplas lobbies forming para o mesmo usuário retornam LOBBY_STATE_CONFLICT mesmo com histórico in_game', () => {
      seedInGameHistory('user-a', { lobbyId: 90, lobbyNumber: 90, position: 1, joinedAtMs: 5_000 });

      insertLobby(db, {
        id: 10,
        lobbyNumber: 3,
        status: 'forming',
        creationType: 'automatic',
        createdAtMs: 20_000,
      });
      insertLobby(db, {
        id: 11,
        lobbyNumber: 4,
        status: 'forming',
        creationType: 'automatic',
        createdAtMs: 20_100,
      });
      insertLobbyPlayer(db, {
        id: 100,
        lobbyId: 10,
        discordId: 'user-a',
        username: 'User A#0001',
        displayName: 'User A',
        position: 1,
        originalJoinedAtMs: 22_000,
        isSubscriber: 0,
      });
      insertLobbyPlayer(db, {
        id: 110,
        lobbyId: 11,
        discordId: 'user-a',
        username: 'User A#0001',
        displayName: 'User A',
        position: 1,
        originalJoinedAtMs: 22_100,
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

      const result = context.queueService.swapParticipantsInCurrentCycle({
        discordIdA: 'user-a',
        discordIdB: 'user-b',
        reason: 'swap conflito multiplo forming',
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe('LOBBY_STATE_CONFLICT');
    });

    test('saída e reentrada posteriores continuam funcionando após histórico in_game', () => {
      seedInGameHistory('user-a', { lobbyId: 95, lobbyNumber: 95, position: 1, joinedAtMs: 5_000 });

      seedQueueEntry(db, {
        id: 1,
        discordId: 'user-a',
        username: 'User A#0001',
        displayName: 'User A',
        isSubscriber: 0,
        joinedAtMs: 20_000,
        queueOrderKey: 110,
      });
      seedQueueEntry(db, {
        id: 2,
        discordId: 'user-c',
        username: 'User C#0001',
        displayName: 'User C',
        isSubscriber: 0,
        joinedAtMs: 21_000,
        queueOrderKey: 220,
      });

      const swapped = context.queueService.swapParticipantsInCurrentCycle({
        discordIdA: 'user-a',
        discordIdB: 'user-c',
        reason: 'swap antes da reentrada',
      });
      expect(swapped.success).toBe(true);

      jest.setSystemTime(new Date('2026-08-10T10:10:00.000Z'));
      const removed = context.queueService.removeFromQueue('user-a');
      expect(removed.success).toBe(true);

      const rejoin = context.queueService.addToQueue({
        discordId: 'user-a',
        username: 'User A#0001',
        displayName: 'User A',
        isSubscriber: 0,
      });
      expect(rejoin.success).toBe(true);

      const rejoinedRow = db.prepare('SELECT queue_order_key FROM queue_entries WHERE discord_id = ?').get('user-a');
      expect(Number.isSafeInteger(rejoinedRow.queue_order_key)).toBe(true);
    });
  });
});
