const { createTestContext, getDb, countRows, insertLobby, insertLobbyPlayer, seedQueueEntry } = require('./helpers/testDatabase');
const { makeQueuePlayers } = require('./helpers/fixtures');

describe('lobby behavior', () => {
  let context;
  let db;

  beforeEach(async () => {
    context = await createTestContext({ nodeEnv: 'test' });
    db = getDb(context.sqliteClient);
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('forma lobbies automáticas por prioridade e deixa waiting o excedente', () => {
    const players = makeQueuePlayers(9, { baseTime: 10_000, subscriberCount: 2, prefix: 'auto' });
    context.queueService.addMultipleToQueue(players);

    const formingLobbies = context.queueService.getActiveLobbies('forming');
    expect(formingLobbies).toHaveLength(2);
    expect(formingLobbies[0].players).toHaveLength(4);
    expect(formingLobbies[1].players).toHaveLength(4);
    expect(formingLobbies[0].players[0].isSubscriber).toBe(true);
    expect(formingLobbies[0].players[0].discordId).toBe('auto-001');
    expect(countRows(db, 'queue_entries')).toBe(1);

    const waiting = db
      .prepare(
        `SELECT discord_id, joined_at_ms FROM queue_entries ORDER BY is_subscriber DESC, joined_at_ms ASC, discord_id ASC`,
      )
      .all();

    expect(waiting).toHaveLength(1);
    expect(waiting[0].discord_id).toBe('auto-009');
  });

  test.each([1, 2, 3, 4])('cria lobby forçada com quantidade %i', (quantity) => {
    const players = makeQueuePlayers(4, { baseTime: 20_000, prefix: `forced-${quantity}` });
    players.forEach((player, index) => {
      seedQueueEntry(db, {
        id: index + 1,
        discordId: player.discordId,
        username: player.username,
        displayName: player.displayName,
        isSubscriber: index === 0 ? 1 : 0,
        joinedAtMs: player.joinedAtMs,
      });
    });

    const result = context.queueService.forceCreateLobby(quantity);
    expect(result.success).toBe(true);
    expect(result.entries).toHaveLength(quantity);

    const lobby = db.prepare(`SELECT creation_type, status FROM lobbies WHERE lobby_number = 1`).get();
    expect(lobby).toMatchObject({ creation_type: 'forced', status: 'forming' });

    const playersInLobby = db
      .prepare(`SELECT discord_id, original_joined_at_ms FROM lobby_players ORDER BY position ASC`)
      .all();
    expect(playersInLobby).toHaveLength(quantity);
    expect(countRows(db, 'queue_entries')).toBe(4 - quantity);
  });

  test('falha ao forçar lobby sem jogadores suficientes', () => {
    seedQueueEntry(db, {
      id: 1,
      discordId: 'insufficient-1',
      username: 'Insufficient 1#0001',
      displayName: 'Insufficient 1',
      isSubscriber: 0,
      joinedAtMs: 30_000,
    });
    seedQueueEntry(db, {
      id: 2,
      discordId: 'insufficient-2',
      username: 'Insufficient 2#0001',
      displayName: 'Insufficient 2',
      isSubscriber: 0,
      joinedAtMs: 30_001,
    });

    const result = context.queueService.forceCreateLobby(3);
    expect(result.success).toBe(false);
    expect(result.available).toBe(2);
  });

  test('inicia lobby por lobby_number e impede reinício', () => {
    insertLobby(db, {
      id: 7,
      lobbyNumber: 17,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 40_000,
    });
    insertLobbyPlayer(db, {
      id: 1,
      lobbyId: 7,
      discordId: 'starter-1',
      username: 'Starter 1#0001',
      displayName: 'Starter 1',
      position: 1,
      originalJoinedAtMs: 40_000,
      isSubscriber: 0,
    });

    const started = context.queueService.startLobbyByNumber(17);
    expect(started).toBe(true);
    expect(db.prepare(`SELECT status FROM lobbies WHERE lobby_number = ?`).get(17).status).toBe('in_game');
    expect(context.queueService.startLobbyByNumber(17)).toBe(false);
    expect(context.queueService.startLobbyByNumber(999)).toBe(false);
  });

  test('bloqueia reentrada em lobby forming e permite em lobby in_game', () => {
    insertLobby(db, {
      id: 20,
      lobbyNumber: 20,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 50_000,
    });
    [1, 2, 3, 4].forEach((position) => {
      insertLobbyPlayer(db, {
        id: 30 + position,
        lobbyId: 20,
        discordId: `forming-user-${position}`,
        username: `Forming User ${position}#0001`,
        displayName: `Forming User ${position}`,
        position,
        originalJoinedAtMs: 50_000 + position,
        isSubscriber: 0,
      });
    });

    insertLobby(db, {
      id: 21,
      lobbyNumber: 21,
      status: 'in_game',
      creationType: 'automatic',
      createdAtMs: 51_000,
    });
    insertLobbyPlayer(db, {
      id: 40,
      lobbyId: 21,
      discordId: 'in-game-user',
      username: 'In Game User#0001',
      displayName: 'In Game User',
      position: 1,
      originalJoinedAtMs: 51_000,
      isSubscriber: 0,
    });

    const blocked = context.queueService.addToQueue({
      discordId: 'forming-user-1',
      username: 'Forming User 1#0001',
      displayName: 'Forming User 1',
      isSubscriber: 0,
    });
    const allowed = context.queueService.addToQueue({
      discordId: 'in-game-user',
      username: 'In Game User#0001',
      displayName: 'In Game User',
      isSubscriber: 0,
    });

    expect(blocked.success).toBe(false);
    expect(blocked.reason).toBe('in_forming_lobby');
    expect(allowed.success).toBe(true);
    expect(countRows(db, 'queue_entries')).toBe(1);
    expect(countRows(db, 'lobby_players')).toBe(5);
  });

  test('remove jogador de forming automática reconstrói lobbies automáticas e preserva forced/in_game', () => {
    const players = makeQueuePlayers(9, { baseTime: 60_000, subscriberCount: 2, prefix: 'rebuild' });
    context.queueService.addMultipleToQueue(players);

    const waitingBefore = db
      .prepare(
        `SELECT discord_id, joined_at_ms FROM queue_entries ORDER BY is_subscriber DESC, joined_at_ms ASC, discord_id ASC`,
      )
      .all();

    insertLobby(db, {
      id: 100,
      lobbyNumber: 100,
      status: 'forming',
      creationType: 'forced',
      createdAtMs: 61_000,
    });
    insertLobbyPlayer(db, {
      id: 100,
      lobbyId: 100,
      discordId: 'forced-user-1',
      username: 'Forced User 1#0001',
      displayName: 'Forced User 1',
      position: 1,
      originalJoinedAtMs: 61_000,
      isSubscriber: 0,
    });

    insertLobby(db, {
      id: 200,
      lobbyNumber: 200,
      status: 'in_game',
      creationType: 'automatic',
      createdAtMs: 62_000,
    });
    insertLobbyPlayer(db, {
      id: 200,
      lobbyId: 200,
      discordId: 'in-game-user-1',
      username: 'In Game User 1#0001',
      displayName: 'In Game User 1',
      position: 1,
      originalJoinedAtMs: 62_000,
      isSubscriber: 0,
    });

    const before = db
      .prepare(
        `SELECT lp.discord_id, lp.original_joined_at_ms, l.creation_type, l.status
         FROM lobby_players lp
         JOIN lobbies l ON l.id = lp.lobby_id
         WHERE l.creation_type = 'automatic' AND l.status = 'forming'
         ORDER BY l.lobby_number ASC, lp.position ASC`,
      )
      .all();

    const removed = context.queueService.removeFromQueue('rebuild-001');
    expect(removed.success).toBe(true);

    const after = db
      .prepare(
        `SELECT lp.discord_id, lp.original_joined_at_ms, l.creation_type, l.status, l.lobby_number
         FROM lobby_players lp
         JOIN lobbies l ON l.id = lp.lobby_id
         ORDER BY l.lobby_number ASC, lp.position ASC`,
      )
      .all();

    const automaticPlayers = after.filter((row) => row.creation_type === 'automatic' && row.status === 'forming');
    const forcedPlayers = after.filter((row) => row.creation_type === 'forced');
    const inGamePlayers = after.filter((row) => row.status === 'in_game');

    expect(automaticPlayers.length).toBe(8);
    expect(new Set(automaticPlayers.map((row) => row.discord_id)).size).toBe(8);
    expect(automaticPlayers.map((row) => row.original_joined_at_ms)).toEqual([
      ...before
        .filter((row) => row.creation_type === 'automatic' && row.status === 'forming' && row.discord_id !== 'rebuild-001')
        .map((row) => row.original_joined_at_ms),
      ...waitingBefore.map((row) => row.joined_at_ms),
    ]);
    expect(forcedPlayers.map((row) => row.discord_id)).toEqual(['forced-user-1']);
    expect(inGamePlayers.map((row) => row.discord_id)).toEqual(['in-game-user-1']);
    expect(countRows(db, 'queue_entries')).toBe(0);
  });
});
