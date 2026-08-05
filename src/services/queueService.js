const { getDatabase } = require('../database/sqliteClient');

function assignLobbies() {
  const db = getDatabase();
  const selectWaiting = db.prepare(
    `SELECT id, discord_id, username, display_name, is_subscriber, joined_at FROM queue_entries WHERE status = 'waiting' ORDER BY is_subscriber DESC, joined_at ASC LIMIT 4`,
  );
  const insertLobby = db.prepare(`INSERT INTO lobbies (status) VALUES ('open')`);
  const insertLobbyPlayer = db.prepare(
    `INSERT INTO lobby_players (lobby_id, discord_id, username, display_name, position) VALUES (?, ?, ?, ?, ?)`,
  );
  const updateQueueStatus = db.prepare(`UPDATE queue_entries SET status = 'assigned' WHERE id = ?`);

  let entries = selectWaiting.all();

  while (entries.length === 4) {
    const lobbyInfo = insertLobby.run();
    const lobbyId = lobbyInfo.lastInsertRowid;

    entries.forEach((entry, index) => {
      insertLobbyPlayer.run(lobbyId, entry.discord_id, entry.username, entry.display_name, index + 1);
      updateQueueStatus.run(entry.id);
    });

    entries = selectWaiting.all();
  }
}

function addToQueue({ discordId, username, displayName, isSubscriber = 0 }) {
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber) VALUES (?, ?, ?, ?)`,
  );

  const transaction = db.transaction((payload) => {
    stmt.run(payload.discordId, payload.username, payload.displayName, payload.isSubscriber ? 1 : 0);
    assignLobbies();
  });

  try {
    transaction({ discordId, username, displayName, isSubscriber });
    return true;
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
    `SELECT id, discord_id, username, display_name, is_subscriber, joined_at, status FROM queue_entries WHERE status = 'waiting' ORDER BY is_subscriber DESC, joined_at ASC`,
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
