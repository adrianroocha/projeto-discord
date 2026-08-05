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
      status TEXT DEFAULT 'forming'
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

  const queueInfo = db.prepare("PRAGMA table_info(queue_entries)").all();
  const hasDisplayName = queueInfo.some((column) => column.name === 'display_name');
  if (!hasDisplayName) {
    db.exec("ALTER TABLE queue_entries ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }
}

module.exports = {
  initDatabase,
};
