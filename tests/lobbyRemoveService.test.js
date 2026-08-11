const {
  createTestContext,
  getDb,
  insertLobby,
  insertLobbyPlayer,
  seedQueueEntry,
} = require('./helpers/testDatabase');

describe('lobby remove service', () => {
  let context;
  let db;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));

    context = await createTestContext({ nodeEnv: 'test' });
    db = getDb(context.sqliteClient);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await context.cleanup();
  });

  function seedFormingLobbyWithTarget({ lobbyId = 10, creationType = 'automatic', rebuildLocked = 0 } = {}) {
    insertLobby(db, {
      id: lobbyId,
      lobbyNumber: 3,
      status: 'forming',
      creationType,
      createdAtMs: 20_000,
    });

    db.prepare('UPDATE lobbies SET rebuild_locked = ? WHERE id = ?').run(rebuildLocked, lobbyId);

    insertLobbyPlayer(db, {
      id: 100,
      lobbyId,
      discordId: 'target-user',
      username: 'Target#0001',
      displayName: 'Target',
      position: 2,
      originalJoinedAtMs: 10_000,
      originalQueueOrderKey: 120,
      isSubscriber: 0,
    });

    insertLobbyPlayer(db, {
      id: 101,
      lobbyId,
      discordId: 'player-1',
      username: 'Player 1#0001',
      displayName: 'Player 1',
      position: 1,
      originalJoinedAtMs: 9_000,
      originalQueueOrderKey: 100,
      isSubscriber: 1,
    });

    insertLobbyPlayer(db, {
      id: 102,
      lobbyId,
      discordId: 'player-3',
      username: 'Player 3#0001',
      displayName: 'Player 3',
      position: 3,
      originalJoinedAtMs: 11_000,
      originalQueueOrderKey: 130,
      isSubscriber: 0,
    });

    insertLobbyPlayer(db, {
      id: 103,
      lobbyId,
      discordId: 'player-4',
      username: 'Player 4#0001',
      displayName: 'Player 4',
      position: 4,
      originalJoinedAtMs: 12_000,
      originalQueueOrderKey: 140,
      isSubscriber: 0,
    });
  }

  test('remove jogador em forming, elimina residual de fila e emite queueUpdated uma vez', () => {
    seedFormingLobbyWithTarget();
    seedQueueEntry(db, {
      id: 500,
      discordId: 'target-user',
      username: 'Target#0001',
      displayName: 'Target',
      isSubscriber: 0,
      joinedAtMs: 99_000,
      queueOrderKey: 999,
      adminSortPriorityOverride: 1,
    });
    seedQueueEntry(db, {
      id: 501,
      discordId: 'queue-fill',
      username: 'Queue Fill#0001',
      displayName: 'Queue Fill',
      isSubscriber: 1,
      joinedAtMs: 13_000,
      queueOrderKey: 150,
    });

    const snapshotsBefore = db
      .prepare('SELECT cycle_id, discord_id, is_subscriber, created_at_ms FROM queue_priority_snapshots ORDER BY cycle_id, discord_id')
      .all();

    const emitSpy = jest.spyOn(context.queueEvents, 'emit');

    const result = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'Jogador ausente',
    });

    expect(result.success).toBe(true);
    expect(result.removedQueueEntries).toBe(1);
    expect(result.removedQueueOverrideEntries).toBe(1);

    const targetInLobby = db.prepare('SELECT id FROM lobby_players WHERE discord_id = ?').get('target-user');
    const targetInQueue = db.prepare('SELECT id FROM queue_entries WHERE discord_id = ?').get('target-user');
    expect(targetInLobby).toBeUndefined();
    expect(targetInQueue).toBeUndefined();

    const afterSnapshots = db
      .prepare('SELECT cycle_id, discord_id, is_subscriber, created_at_ms FROM queue_priority_snapshots ORDER BY cycle_id, discord_id')
      .all();
    expect(afterSnapshots).toEqual(snapshotsBefore);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenLastCalledWith('queueUpdated');
  });

  test('lobby in_game é imutável sem mutação e sem emissão', () => {
    insertLobby(db, {
      id: 90,
      lobbyNumber: 90,
      status: 'in_game',
      creationType: 'automatic',
      createdAtMs: 40_000,
    });
    insertLobbyPlayer(db, {
      id: 900,
      lobbyId: 90,
      discordId: 'target-user',
      username: 'Target#0001',
      displayName: 'Target',
      position: 1,
      originalJoinedAtMs: 39_000,
      isSubscriber: 0,
    });

    const emitSpy = jest.spyOn(context.queueEvents, 'emit');
    const beforeLobby = db.prepare('SELECT * FROM lobby_players WHERE lobby_id = 90').all();

    const result = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'Jogador ausente',
    });

    const afterLobby = db.prepare('SELECT * FROM lobby_players WHERE lobby_id = 90').all();

    expect(result.success).toBe(false);
    expect(result.reason).toBe('LOBBY_IMMUTABLE');
    expect(afterLobby).toEqual(beforeLobby);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  test('usuário apenas na fila não é removido por este comando', () => {
    seedQueueEntry(db, {
      id: 1,
      discordId: 'target-user',
      username: 'Target#0001',
      displayName: 'Target',
      isSubscriber: 0,
      joinedAtMs: 10_000,
      queueOrderKey: 200,
    });

    const emitSpy = jest.spyOn(context.queueEvents, 'emit');
    const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key').all();

    const result = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'Jogador ausente',
    });

    const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key').all();

    expect(result.success).toBe(false);
    expect(result.reason).toBe('LOBBY_PLAYER_NOT_FOUND');
    expect(afterQueue).toEqual(beforeQueue);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  test('usuário fora de lobby no ciclo atual retorna not found sem alterar histórico', () => {
    insertLobby(db, {
      id: 91,
      lobbyNumber: 91,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 50_000,
    });
    insertLobbyPlayer(db, {
      id: 901,
      lobbyId: 91,
      discordId: 'other-user',
      username: 'Other#0001',
      displayName: 'Other',
      position: 1,
      originalJoinedAtMs: 49_000,
      isSubscriber: 0,
    });

    const before = db.prepare('SELECT discord_id, lobby_id FROM lobby_players ORDER BY id').all();
    const result = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'Jogador ausente',
    });
    const after = db.prepare('SELECT discord_id, lobby_id FROM lobby_players ORDER BY id').all();

    expect(result.success).toBe(false);
    expect(result.reason).toBe('LOBBY_PLAYER_NOT_FOUND');
    expect(after).toEqual(before);
  });

  test('inconsistência com múltiplas lobbies forming para o mesmo usuário retorna conflito e rollback', () => {
    seedFormingLobbyWithTarget({ lobbyId: 10, creationType: 'automatic' });

    insertLobby(db, {
      id: 11,
      lobbyNumber: 4,
      status: 'forming',
      creationType: 'forced',
      createdAtMs: 21_000,
    });
    insertLobbyPlayer(db, {
      id: 110,
      lobbyId: 11,
      discordId: 'target-user',
      username: 'Target#0001',
      displayName: 'Target',
      position: 1,
      originalJoinedAtMs: 10_000,
      isSubscriber: 0,
    });

    const beforeLobby = db.prepare('SELECT lobby_id, discord_id, position FROM lobby_players ORDER BY lobby_id, position').all();
    const emitSpy = jest.spyOn(context.queueEvents, 'emit');

    const result = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'Jogador ausente',
    });

    const afterLobby = db.prepare('SELECT lobby_id, discord_id, position FROM lobby_players ORDER BY lobby_id, position').all();

    expect(result.success).toBe(false);
    expect(result.reason).toBe('LOBBY_STATE_CONFLICT');
    expect(afterLobby).toEqual(beforeLobby);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  test('rollback restaura tudo em falha transacional interna', () => {
    seedFormingLobbyWithTarget();
    seedQueueEntry(db, {
      id: 700,
      discordId: 'target-user',
      username: 'Target#0001',
      displayName: 'Target',
      isSubscriber: 0,
      joinedAtMs: 20_000,
      queueOrderKey: 220,
      adminSortPriorityOverride: 1,
    });

    const beforeQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY id').all();
    const beforeLobby = db.prepare('SELECT discord_id, lobby_id, position FROM lobby_players ORDER BY id').all();

    const realPrepare = db.prepare.bind(db);
    jest.spyOn(db, 'prepare').mockImplementation((sql) => {
      const stmt = realPrepare(sql);
      if (String(sql).includes('DELETE FROM queue_entries WHERE id = ?')) {
        return {
          run: () => {
            throw new Error('forced delete failure');
          },
        };
      }
      return stmt;
    });

    const result = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'Jogador ausente',
    });

    const afterQueue = db.prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY id').all();
    const afterLobby = db.prepare('SELECT discord_id, lobby_id, position FROM lobby_players ORDER BY id').all();

    expect(result.success).toBe(false);
    expect(result.reason).toBe('REMOVE_TRANSACTION_FAILED');
    expect(afterQueue).toEqual(beforeQueue);
    expect(afterLobby).toEqual(beforeLobby);
  });

  test('libera rebuild_locked conforme política e aplica rebuild canônico', () => {
    seedFormingLobbyWithTarget({ rebuildLocked: 1, creationType: 'automatic' });
    seedQueueEntry(db, {
      id: 510,
      discordId: 'queue-fill',
      username: 'Queue Fill#0001',
      displayName: 'Queue Fill',
      isSubscriber: 0,
      joinedAtMs: 13_000,
      queueOrderKey: 150,
    });

    const result = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'Jogador ausente',
    });

    expect(result.success).toBe(true);
    expect(result.unlockedRebuild).toBe(true);

    const lockRow = db.prepare('SELECT rebuild_locked FROM lobbies WHERE id = 10').get();
    if (lockRow) {
      expect(lockRow.rebuild_locked).toBe(0);
    }
  });

  test('sem aguardando e lobby forced mantém coerência com vaga aberta', () => {
    seedFormingLobbyWithTarget({ creationType: 'forced' });

    const result = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'Jogador ausente',
    });

    expect(result.success).toBe(true);
    const rows = db.prepare('SELECT discord_id, position FROM lobby_players WHERE lobby_id = 10 ORDER BY position').all();
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.discord_id === 'target-user')).toBe(false);
  });

  test('saída após swap remove corretamente jogador substituto e limpa override residual na fila', () => {
    seedFormingLobbyWithTarget({ creationType: 'automatic' });
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

    const swapped = context.queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: 'target-user',
      queueDiscordId: 'user-b',
      reason: 'troca operacional',
    });
    expect(swapped.success).toBe(true);

    const removed = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'user-b',
      reason: 'Jogador ausente',
    });

    expect(removed.success).toBe(true);
    const queueRow = db.prepare('SELECT id FROM queue_entries WHERE discord_id = ?').get('user-b');
    const lobbyRow = db.prepare('SELECT id FROM lobby_players WHERE discord_id = ?').get('user-b');
    expect(queueRow).toBeUndefined();
    expect(lobbyRow).toBeUndefined();
  });

  test('reentrada posterior recebe nova posição e override nulo', () => {
    seedFormingLobbyWithTarget({ creationType: 'forced' });

    const removed = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'Jogador ausente',
    });
    expect(removed.success).toBe(true);

    const rejoin = context.queueService.addToQueue({
      discordId: 'target-user',
      username: 'Target#0001',
      displayName: 'Target',
      isSubscriber: 0,
    });
    expect(rejoin.success).toBe(true);

    const row = db
      .prepare('SELECT queue_order_key, admin_sort_priority_override FROM queue_entries WHERE discord_id = ?')
      .get('target-user');
    expect(Number.isSafeInteger(row.queue_order_key)).toBe(true);
    expect(row.queue_order_key).toBeGreaterThan(0);
    expect(row.admin_sort_priority_override).toBeNull();
  });

  test('não altera prioridade snapshot, vínculo Kick nem concessão manual SUB', () => {
    seedFormingLobbyWithTarget({ creationType: 'forced' });

    db.prepare(
      'INSERT INTO queue_priority_snapshots (cycle_id, discord_id, is_subscriber, created_at_ms) VALUES (?, ?, ?, ?)',
    ).run(1, 'target-user', 1, 10_000);
    db.prepare(
      'INSERT INTO kick_accounts (discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run('target-user', 'kick-1', 'targetkick', 9_000, 9_000);
    db.prepare(
      `INSERT INTO manual_sub_grants (
        discord_id, granted_by_discord_id, reason, granted_at_ms, expires_at_ms, revoked_at_ms, revoked_by_discord_id, revoke_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('target-user', 'mod-1', 'grant', 9_000, null, null, null, null);

    const snapshotsBefore = db
      .prepare('SELECT cycle_id, discord_id, is_subscriber, created_at_ms FROM queue_priority_snapshots ORDER BY cycle_id, discord_id')
      .all();
    const kickBefore = db.prepare('SELECT * FROM kick_accounts WHERE discord_id = ?').get('target-user');
    const grantsBefore = db.prepare('SELECT discord_id, reason, revoked_at_ms FROM manual_sub_grants WHERE discord_id = ?').all('target-user');

    const removed = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'Jogador ausente',
    });
    expect(removed.success).toBe(true);

    const snapshotsAfter = db
      .prepare('SELECT cycle_id, discord_id, is_subscriber, created_at_ms FROM queue_priority_snapshots ORDER BY cycle_id, discord_id')
      .all();
    const kickAfter = db.prepare('SELECT * FROM kick_accounts WHERE discord_id = ?').get('target-user');
    const grantsAfter = db.prepare('SELECT discord_id, reason, revoked_at_ms FROM manual_sub_grants WHERE discord_id = ?').all('target-user');

    expect(snapshotsAfter).toEqual(snapshotsBefore);
    expect(kickAfter).toEqual(kickBefore);
    expect(grantsAfter).toEqual(grantsBefore);
  });

  test('entrada inválida retorna INVALID_INPUT e não emite evento', () => {
    const emitSpy = jest.spyOn(context.queueEvents, 'emit');

    const a = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: '',
      reason: 'Jogador ausente',
    });
    const b = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'ab',
    });
    const c = context.queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: 'target-user',
      reason: 'x'.repeat(201),
    });

    expect(a).toEqual({ success: false, reason: 'INVALID_INPUT' });
    expect(b).toEqual({ success: false, reason: 'INVALID_INPUT' });
    expect(c).toEqual({ success: false, reason: 'INVALID_INPUT' });
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
