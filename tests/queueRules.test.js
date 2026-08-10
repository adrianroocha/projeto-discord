const { createTestContext, getDb, countRows, seedQueueEntry } = require('./helpers/testDatabase');
const { makeQueuePlayers } = require('./helpers/fixtures');

describe('queue rules', () => {
  let context;
  let db;

  beforeEach(async () => {
    context = await createTestContext({ nodeEnv: 'test' });
    db = getDb(context.sqliteClient);
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('adiciona jogador simples com timestamp numérico e emite evento', () => {
    const emitSpy = jest.spyOn(context.queueEvents, 'emit');
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

    const result = context.queueService.addToQueue({
      discordId: 'user-basic-1',
      username: 'User Basic#0001',
      displayName: 'User Basic',
      isSubscriber: 1,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        joinedLobby: false,
        isSubscriber: 1,
      }),
    );
    expect(countRows(db, 'queue_entries')).toBe(1);

    const row = db
      .prepare(
        `SELECT discord_id, username, display_name, is_subscriber, joined_at_ms FROM queue_entries WHERE discord_id = ?`,
      )
      .get('user-basic-1');

    expect(row).toMatchObject({
      discord_id: 'user-basic-1',
      username: 'User Basic#0001',
      display_name: 'User Basic',
      is_subscriber: 1,
      joined_at_ms: 1_000_000,
    });
    expect(typeof row.joined_at_ms).toBe('number');
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenLastCalledWith('queueUpdated');
  });

  test('rejeita duplicidade e mantém apenas um registro', () => {
    const emitSpy = jest.spyOn(context.queueEvents, 'emit');

    const first = context.queueService.addToQueue({
      discordId: 'user-dup-1',
      username: 'User Dup#0001',
      displayName: 'User Dup',
      isSubscriber: 0,
    });
    const second = context.queueService.addToQueue({
      discordId: 'user-dup-1',
      username: 'User Dup#0001',
      displayName: 'User Dup',
      isSubscriber: 0,
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.reason).toBe('already_waiting');
    expect(countRows(db, 'queue_entries')).toBe(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  test('ordena por SUB, timestamp e discord_id', () => {
    seedQueueEntry(db, {
      id: 1,
      discordId: 'user-200',
      username: 'User 200#0001',
      displayName: 'User 200',
      isSubscriber: 0,
      joinedAtMs: 2_000,
      queueOrderKey: 4,
    });
    seedQueueEntry(db, {
      id: 2,
      discordId: 'user-100',
      username: 'User 100#0001',
      displayName: 'User 100',
      isSubscriber: 1,
      joinedAtMs: 3_000,
      queueOrderKey: 1,
    });
    seedQueueEntry(db, {
      id: 3,
      discordId: 'user-150',
      username: 'User 150#0001',
      displayName: 'User 150',
      isSubscriber: 0,
      joinedAtMs: 1_000,
      queueOrderKey: 3,
    });
    seedQueueEntry(db, {
      id: 4,
      discordId: 'user-050',
      username: 'User 050#0001',
      displayName: 'User 050',
      isSubscriber: 0,
      joinedAtMs: 1_000,
      queueOrderKey: 2,
    });

    const queue = context.queueService.getQueue();
    expect(queue.map((row) => row.discord_id)).toEqual(['user-100', 'user-050', 'user-150', 'user-200']);
  });

  test('adiciona múltiplos jogadores em lote e emite apenas uma vez', () => {
    const emitSpy = jest.spyOn(context.queueEvents, 'emit');
    const players = makeQueuePlayers(3, { baseTime: 5_000, subscriberCount: 1 });

    context.queueService.addMultipleToQueue(players);

    expect(countRows(db, 'queue_entries')).toBe(3);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  test('remove jogador waiting e emite evento', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(7_000);
    context.queueService.addToQueue({
      discordId: 'user-waiting-1',
      username: 'User Waiting#0001',
      displayName: 'User Waiting',
      isSubscriber: 0,
    });

    nowSpy.mockReturnValue(130_000);
    const emitSpy = jest.spyOn(context.queueEvents, 'emit');
    const result = context.queueService.removeFromQueue('user-waiting-1');

    expect(result.success).toBe(true);
    expect(result.removedFromQueue).toBe(true);
    expect(countRows(db, 'queue_entries')).toBe(0);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });
});
