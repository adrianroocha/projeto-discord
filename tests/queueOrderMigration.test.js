const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

describe('queue order migration', () => {
  let tempDir;
  let databasePath;

  function createLegacySchema(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS queue_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_subscriber INTEGER DEFAULT 0,
        joined_at_ms INTEGER NOT NULL,
        status TEXT DEFAULT 'waiting'
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS lobbies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        status TEXT DEFAULT 'forming',
        creation_type TEXT NOT NULL DEFAULT 'automatic',
        lobby_number INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS lobby_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lobby_id INTEGER NOT NULL,
        discord_id TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        position INTEGER NOT NULL,
        original_joined_at_ms INTEGER NOT NULL,
        is_subscriber INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (lobby_id) REFERENCES lobbies(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS queue_cycle_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_cycle_id INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);

    db.prepare('INSERT OR REPLACE INTO queue_cycle_state (id, current_cycle_id, updated_at_ms) VALUES (1, 1, 0)').run();
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projeto-discord-migration-'));
    databasePath = path.join(tempDir, 'database.sqlite');
  });

  afterEach(async () => {
    jest.resetModules();
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_TOKEN;
    delete process.env.GUILD_ID;

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('migration é idempotente e preserva ordem operacional anterior', async () => {
    const legacyDb = new Database(databasePath);
    createLegacySchema(legacyDb);

    legacyDb
      .prepare(
        'INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms) VALUES (?, ?, ?, ?, ?)',
      )
      .run('legacy-regular-late', 'Regular Late#0001', 'Regular Late', 0, 30_000);
    legacyDb
      .prepare(
        'INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms) VALUES (?, ?, ?, ?, ?)',
      )
      .run('legacy-sub', 'Sub#0001', 'Sub', 1, 35_000);
    legacyDb
      .prepare(
        'INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms) VALUES (?, ?, ?, ?, ?)',
      )
      .run('legacy-regular-early', 'Regular Early#0001', 'Regular Early', 0, 10_000);
    legacyDb
      .prepare(
        'INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms) VALUES (?, ?, ?, ?, ?)',
      )
      .run('legacy-regular-tie-a', 'Regular Tie A#0001', 'Regular Tie A', 0, 10_000);
    legacyDb
      .prepare(
        'INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms) VALUES (?, ?, ?, ?, ?)',
      )
      .run('legacy-regular-tie-b', 'Regular Tie B#0001', 'Regular Tie B', 0, 10_000);

    legacyDb.close();

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_PATH = databasePath;
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.GUILD_ID = 'test-guild';

    const database = require('../src/database/database');
    const sqliteClient = require('../src/database/sqliteClient');

    await database.initDatabase();
    const db = sqliteClient.getDatabase();

    const firstOrder = db
      .prepare(
        `SELECT discord_id
         FROM queue_entries
         ORDER BY COALESCE(admin_sort_priority_override, is_subscriber) DESC,
                  COALESCE(queue_order_key, joined_at_ms) ASC,
                  discord_id ASC`,
      )
      .all()
      .map((row) => row.discord_id);

    expect(firstOrder).toEqual([
      'legacy-sub',
      'legacy-regular-early',
      'legacy-regular-tie-a',
      'legacy-regular-tie-b',
      'legacy-regular-late',
    ]);

    const firstKeys = db
      .prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC')
      .all();

    expect(firstKeys.every((row) => Number.isSafeInteger(row.queue_order_key) && row.queue_order_key > 0)).toBe(true);

    const sequenceBefore = db.prepare('SELECT next_order_key FROM queue_order_sequence WHERE id = 1').get().next_order_key;
    const maxBefore = db.prepare('SELECT MAX(queue_order_key) AS max_key FROM queue_entries').get().max_key;
    expect(sequenceBefore).toBeGreaterThan(maxBefore);

    await database.initDatabase();

    const secondOrder = db
      .prepare(
        `SELECT discord_id
         FROM queue_entries
         ORDER BY COALESCE(admin_sort_priority_override, is_subscriber) DESC,
                  COALESCE(queue_order_key, joined_at_ms) ASC,
                  discord_id ASC`,
      )
      .all()
      .map((row) => row.discord_id);

    expect(secondOrder).toEqual(firstOrder);

    const secondKeys = db
      .prepare('SELECT discord_id, queue_order_key FROM queue_entries ORDER BY queue_order_key ASC')
      .all();

    expect(secondKeys).toEqual(firstKeys);

    const sequenceAfter = db.prepare('SELECT next_order_key FROM queue_order_sequence WHERE id = 1').get().next_order_key;
    expect(sequenceAfter).toBe(sequenceBefore);

    await sqliteClient.closeConnection();
  });
});
