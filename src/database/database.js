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

  db.exec(createUsersTableSql);
}

module.exports = {
  initDatabase,
};
