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
      is_subscriber INTEGER DEFAULT 0,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'waiting'
    )
  `;

  db.exec(createUsersTableSql);
  db.exec(createQueueEntriesTableSql);
}

module.exports = {
  initDatabase,
};
