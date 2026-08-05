const { openConnection, getDatabase } = require('./sqliteClient');

async function initDatabase() {
  await openConnection();

  const db = getDatabase();
  const createUsersTableSql = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const createQueueEntriesTableSql = `
    CREATE TABLE IF NOT EXISTS queue_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      is_subscriber INTEGER DEFAULT 0,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'waiting'
    )
  `;

  const createLobbiesTableSql = `
    CREATE TABLE IF NOT EXISTS lobbies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'forming',
      creation_type TEXT NOT NULL DEFAULT 'automatic',
      lobby_number INTEGER NOT NULL
    )
  `;

  const createLobbyPlayersTableSql = `
    CREATE TABLE IF NOT EXISTS lobby_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lobby_id INTEGER NOT NULL,
      discord_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      position INTEGER NOT NULL,
      original_joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_subscriber INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (lobby_id) REFERENCES lobbies(id)
    )
  `;

  db.exec(createUsersTableSql);
  db.exec(createQueueEntriesTableSql);
  db.exec(createLobbiesTableSql);
  db.exec(createLobbyPlayersTableSql);

  const lobbyInfo = db.prepare("PRAGMA table_info(lobbies)").all();
  const hasLobbyStatus = lobbyInfo.some((column) => column.name === 'status');
  if (!hasLobbyStatus) {
    db.exec("ALTER TABLE lobbies ADD COLUMN status TEXT NOT NULL DEFAULT 'forming'");
  }

  db.exec("UPDATE lobbies SET status = 'forming' WHERE status = 'open'");

  // Add creation_type column to lobbies to differentiate automatic vs forced lobbies (idempotent)
  const hasCreationType = lobbyInfo.some((column) => column.name === 'creation_type');
  if (!hasCreationType) {
    db.exec("ALTER TABLE lobbies ADD COLUMN creation_type TEXT NOT NULL DEFAULT 'automatic'");
  }

  const hasLobbyNumber = db.prepare("PRAGMA table_info(lobbies)").all().some((column) => column.name === 'lobby_number');
  if (!hasLobbyNumber) {
    db.exec("ALTER TABLE lobbies ADD COLUMN lobby_number INTEGER NOT NULL DEFAULT 0");
  }

  const hasOriginalJoinedAt = db.prepare("PRAGMA table_info(lobby_players)").all().some((column) => column.name === 'original_joined_at');
  if (!hasOriginalJoinedAt) {
    db.exec("ALTER TABLE lobby_players ADD COLUMN original_joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
  }

  const hasLobbyPlayerSubscriber = db.prepare("PRAGMA table_info(lobby_players)").all().some((column) => column.name === 'is_subscriber');
  if (!hasLobbyPlayerSubscriber) {
    db.exec("ALTER TABLE lobby_players ADD COLUMN is_subscriber INTEGER NOT NULL DEFAULT 0");
  }

  const queueInfo = db.prepare("PRAGMA table_info(queue_entries)").all();
  const hasDisplayName = queueInfo.some((column) => column.name === 'display_name');
  if (!hasDisplayName) {
    db.exec("ALTER TABLE queue_entries ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }

  // Ensure queue_entries does not contain players that are already in lobbies
  // (safe to run multiple times)
  try {
    const count = db.prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='table' AND name='lobby_players'").get();
    if (count && count.c > 0) {
      db.exec(
        "DELETE FROM queue_entries WHERE discord_id IN (SELECT DISTINCT discord_id FROM lobby_players)"
      );
    }
  } catch (err) {
    // ignore if something unexpected happens during cleanup
    console.error('Cleanup migration warning:', err && err.message);
  }

  const indexInfo = db.prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_lobbies_lobby_number'").get();
  if (indexInfo && indexInfo.c === 0) {
    try {
      db.exec('CREATE UNIQUE INDEX idx_lobbies_lobby_number ON lobbies(lobby_number)');
    } catch (err) {
      console.error('Erro ao criar índice de lobby_number:', err && err.message);
    }
  }
}

module.exports = {
  initDatabase,
};
