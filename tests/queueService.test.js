const fs = require('fs');
const os = require('os');
const path = require('path');

function createTempDatabasePath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projeto-discord-queue-'));
  return {
    tempDir,
    databasePath: path.join(tempDir, 'database.sqlite'),
  };
}

async function loadQueueService(databasePath) {
  jest.resetModules();
  process.env.NODE_ENV = 'development';
  process.env.DATABASE_PATH = databasePath;
  process.env.DISCORD_TOKEN = 'test-token';
  process.env.GUILD_ID = 'test-guild';

  const database = require('../src/database/database');
  const sqliteClient = require('../src/database/sqliteClient');
  const queueService = require('../src/services/queueService');

  await database.initDatabase();
  return { sqliteClient, queueService };
}

describe('queueService timestamps', () => {
  let tempDir;
  let databasePath;
  let sqliteClient;
  let queueService;

  beforeEach(async () => {
    const created = createTempDatabasePath();
    tempDir = created.tempDir;
    databasePath = created.databasePath;
    const loaded = await loadQueueService(databasePath);
    sqliteClient = loaded.sqliteClient;
    queueService = loaded.queueService;
  });

  afterEach(async () => {
    if (sqliteClient) {
      await sqliteClient.closeConnection();
    }

    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_TOKEN;
    delete process.env.GUILD_ID;
    delete process.env.NODE_ENV;
    jest.restoreAllMocks();
    jest.resetModules();

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('cooldown usa milissegundos e libera test-user em desenvolvimento', () => {
    const baseTime = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    const joined = queueService.addToQueue({
      discordId: 'user-real-1',
      username: 'User Real#0001',
      displayName: 'User Real',
      isSubscriber: 0,
    });
    expect(joined.success).toBe(true);

    Date.now.mockReturnValue(baseTime + 1_000);
    const cooldown = queueService.getLeaveCooldown('user-real-1');
    expect(cooldown).toEqual({ canLeave: false, remainingSeconds: 119 });

    Date.now.mockReturnValue(baseTime + 1_000);
    const devCooldown = queueService.getLeaveCooldown('test-user-001');
    expect(devCooldown).toEqual({ canLeave: true, remainingSeconds: 0 });
  });

  test('ordena real e fictícios por timestamp e mantém SUB na frente no rebuild', () => {
    const baseTime = 2_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    const realUser = queueService.addToQueue({
      discordId: 'user-real-2',
      username: 'User Real#0002',
      displayName: 'User Real 2',
      isSubscriber: 0,
    });
    expect(realUser.success).toBe(true);

    queueService.addMultipleToQueue([
      {
        discordId: 'test-user-001',
        username: 'Jogador Teste 01',
        displayName: 'Jogador Teste 01',
        isSubscriber: 0,
        joinedAtMs: baseTime + 1,
      },
      {
        discordId: 'test-user-002',
        username: 'Jogador Teste 02',
        displayName: 'Jogador Teste 02',
        isSubscriber: 0,
        joinedAtMs: baseTime + 2,
      },
      {
        discordId: 'test-user-003',
        username: 'Jogador Teste 03',
        displayName: 'Jogador Teste 03',
        isSubscriber: 0,
        joinedAtMs: baseTime + 3,
      },
    ]);

    const lobbyRows = sqliteClient
      .getDatabase()
      .prepare(
        `
        SELECT lp.discord_id, lp.position, lp.original_joined_at_ms
        FROM lobby_players lp
        JOIN lobbies l ON l.id = lp.lobby_id
        WHERE l.status = 'forming' AND l.creation_type = 'automatic'
        ORDER BY lp.position ASC
      `,
      )
      .all();

    expect(lobbyRows.map((row) => row.discord_id)).toEqual([
      'user-real-2',
      'test-user-001',
      'test-user-002',
      'test-user-003',
    ]);
    expect(lobbyRows.map((row) => row.original_joined_at_ms)).toEqual([
      baseTime,
      baseTime + 1,
      baseTime + 2,
      baseTime + 3,
    ]);
  });

  test('preserva timestamp ao mover jogador da fila para lobby em rebuild', () => {
    const baseTime = 3_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    queueService.addMultipleToQueue([
      {
        discordId: 'user-old-1',
        username: 'User Old 1#0001',
        displayName: 'User Old 1',
        isSubscriber: 0,
        joinedAtMs: baseTime - 130_000,
      },
      {
        discordId: 'user-old-2',
        username: 'User Old 2#0002',
        displayName: 'User Old 2',
        isSubscriber: 0,
        joinedAtMs: baseTime - 129_000,
      },
      {
        discordId: 'user-old-3',
        username: 'User Old 3#0003',
        displayName: 'User Old 3',
        isSubscriber: 0,
        joinedAtMs: baseTime - 128_000,
      },
      {
        discordId: 'user-old-4',
        username: 'User Old 4#0004',
        displayName: 'User Old 4',
        isSubscriber: 0,
        joinedAtMs: baseTime - 127_000,
      },
      {
        discordId: 'user-old-5',
        username: 'User Old 5#0005',
        displayName: 'User Old 5',
        isSubscriber: 0,
        joinedAtMs: baseTime - 126_000,
      },
    ]);

    const originalLeftover = sqliteClient
      .getDatabase()
      .prepare(`SELECT joined_at_ms FROM queue_entries WHERE discord_id = ?`)
      .get('user-old-5');

    expect(originalLeftover.joined_at_ms).toBe(baseTime - 126_000);

    Date.now.mockReturnValue(baseTime + 130_000);
    const removal = queueService.removeFromQueue('user-old-1');
    expect(removal.success).toBe(true);

    const movedPlayer = sqliteClient
      .getDatabase()
      .prepare(
        `
        SELECT lp.original_joined_at_ms
        FROM lobby_players lp
        JOIN lobbies l ON l.id = lp.lobby_id
        WHERE lp.discord_id = ? AND l.status = 'forming' AND l.creation_type = 'automatic'
      `,
      )
      .get('user-old-5');

    if (movedPlayer) {
      expect(movedPlayer.original_joined_at_ms).toBe(baseTime - 126_000);
      return;
    }

    const remainingQueueEntry = sqliteClient
      .getDatabase()
      .prepare(`SELECT joined_at_ms FROM queue_entries WHERE discord_id = ?`)
      .get('user-old-5');

    expect(remainingQueueEntry.joined_at_ms).toBe(baseTime - 126_000);
  });

  test('resetQueueCycle apaga todo o estado do ciclo', () => {
    const baseTime = 4_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    queueService.addMultipleToQueue([
      {
        discordId: 'user-reset-1',
        username: 'User Reset 1#0001',
        displayName: 'User Reset 1',
        isSubscriber: 0,
        joinedAtMs: baseTime,
      },
      {
        discordId: 'user-reset-2',
        username: 'User Reset 2#0002',
        displayName: 'User Reset 2',
        isSubscriber: 0,
        joinedAtMs: baseTime + 1,
      },
      {
        discordId: 'user-reset-3',
        username: 'User Reset 3#0003',
        displayName: 'User Reset 3',
        isSubscriber: 0,
        joinedAtMs: baseTime + 2,
      },
      {
        discordId: 'user-reset-4',
        username: 'User Reset 4#0004',
        displayName: 'User Reset 4',
        isSubscriber: 0,
        joinedAtMs: baseTime + 3,
      },
    ]);

    const beforeReset = sqliteClient.getDatabase();
    expect(beforeReset.prepare(`SELECT COUNT(1) AS count FROM lobby_players`).get().count).toBeGreaterThan(0);
    expect(beforeReset.prepare(`SELECT COUNT(1) AS count FROM lobbies`).get().count).toBeGreaterThan(0);

    const result = queueService.resetQueueCycle();
    expect(result).toBe(true);

    expect(beforeReset.prepare(`SELECT COUNT(1) AS count FROM queue_entries`).get().count).toBe(0);
    expect(beforeReset.prepare(`SELECT COUNT(1) AS count FROM lobby_players`).get().count).toBe(0);
    expect(beforeReset.prepare(`SELECT COUNT(1) AS count FROM lobbies`).get().count).toBe(0);
  });

  test('entrada normal grava override nulo e chave de ordem monotônica', () => {
    jest.spyOn(Date, 'now').mockReturnValue(5_000_000);

    queueService.addToQueue({
      discordId: 'normal-1',
      username: 'Normal 1#0001',
      displayName: 'Normal 1',
      isSubscriber: 0,
    });

    queueService.addToQueue({
      discordId: 'normal-2',
      username: 'Normal 2#0001',
      displayName: 'Normal 2',
      isSubscriber: 1,
    });

    const rows = sqliteClient
      .getDatabase()
      .prepare(
        `SELECT discord_id, is_subscriber, queue_order_key, admin_sort_priority_override
         FROM queue_entries
         ORDER BY queue_order_key ASC`,
      )
      .all();

    expect(rows).toHaveLength(2);
    expect(rows[0].admin_sort_priority_override).toBeNull();
    expect(rows[1].admin_sort_priority_override).toBeNull();
    expect(rows[1].queue_order_key).toBe(rows[0].queue_order_key + 1);
  });

  test('inserção em lote gera queue_order_key distintas', () => {
    queueService.addMultipleToQueue([
      { discordId: 'batch-1', username: 'Batch 1#0001', displayName: 'Batch 1', isSubscriber: 0, joinedAtMs: 10_000 },
      { discordId: 'batch-2', username: 'Batch 2#0001', displayName: 'Batch 2', isSubscriber: 1, joinedAtMs: 10_001 },
      { discordId: 'batch-3', username: 'Batch 3#0001', displayName: 'Batch 3', isSubscriber: 0, joinedAtMs: 10_002 },
    ]);

    const rows = sqliteClient
      .getDatabase()
      .prepare('SELECT queue_order_key FROM queue_entries ORDER BY queue_order_key ASC')
      .all();

    const keys = rows.map((row) => row.queue_order_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('ordenação canônica usa override temporário sem alterar prioridade real', () => {
    queueService.addMultipleToQueue([
      { discordId: 'canon-sub', username: 'Canon Sub#0001', displayName: 'Canon Sub', isSubscriber: 1, joinedAtMs: 20_000 },
      { discordId: 'canon-regular', username: 'Canon Regular#0001', displayName: 'Canon Regular', isSubscriber: 0, joinedAtMs: 20_001 },
    ]);

    const db = sqliteClient.getDatabase();
    db.prepare('UPDATE queue_entries SET admin_sort_priority_override = 1 WHERE discord_id = ?').run('canon-regular');

    const queue = queueService.getQueue();
    expect(queue[0].discord_id).toBe('canon-sub');
    expect(queue[1].discord_id).toBe('canon-regular');
    expect(queue[1].is_subscriber).toBe(0);
    expect(queue[1].effective_sort_priority).toBe(1);
  });

  test('sequência de ordenação persiste após reinicialização', async () => {
    queueService.addMultipleToQueue([
      { discordId: 'persist-1', username: 'Persist 1#0001', displayName: 'Persist 1', isSubscriber: 0, joinedAtMs: 30_000 },
      { discordId: 'persist-2', username: 'Persist 2#0001', displayName: 'Persist 2', isSubscriber: 0, joinedAtMs: 30_001 },
    ]);

    const before = sqliteClient
      .getDatabase()
      .prepare('SELECT MAX(queue_order_key) AS max_key FROM queue_entries')
      .get().max_key;

    await sqliteClient.closeConnection();
    const loaded = await loadQueueService(databasePath);
    sqliteClient = loaded.sqliteClient;
    queueService = loaded.queueService;

    queueService.addToQueue({
      discordId: 'persist-3',
      username: 'Persist 3#0001',
      displayName: 'Persist 3',
      isSubscriber: 0,
    });

    const after = sqliteClient
      .getDatabase()
      .prepare('SELECT queue_order_key FROM queue_entries WHERE discord_id = ?')
      .get('persist-3').queue_order_key;

    expect(after).toBeGreaterThan(before);
  });
});
