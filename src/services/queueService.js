const { getDatabase } = require('../database/sqliteClient');

function addToQueue({ discordId, username, isSubscriber = 0 }) {
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT INTO queue_entries (discord_id, username, is_subscriber) VALUES (?, ?, ?)`,
  );

  try {
    const info = stmt.run(discordId, username, isSubscriber ? 1 : 0);
    return info.changes > 0;
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return false;
    }
    throw error;
  }
}

function removeFromQueue(discordId) {
  const db = getDatabase();
  const stmt = db.prepare(`DELETE FROM queue_entries WHERE discord_id = ? AND status = 'waiting'`);
  const info = stmt.run(discordId);
  return info.changes > 0;
}

function getQueue() {
  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT id, discord_id, username, is_subscriber, joined_at, status FROM queue_entries WHERE status = 'waiting' ORDER BY joined_at ASC`,
  );
  return stmt.all();
}

function isUserInQueue(discordId) {
  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT COUNT(1) AS count FROM queue_entries WHERE discord_id = ? AND status = 'waiting'`,
  );
  const row = stmt.get(discordId);
  return row.count > 0;
}

module.exports = {
  addToQueue,
  removeFromQueue,
  getQueue,
  isUserInQueue,
};
