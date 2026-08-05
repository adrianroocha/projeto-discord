const { getDatabase } = require('../database/sqliteClient');
const queueEvents = require('./queueEvents');

function selectWaitingEntries(limit = 4) {
  const db = getDatabase();
  const query = `SELECT id, discord_id, username, display_name, is_subscriber, joined_at FROM queue_entries WHERE status = 'waiting' ORDER BY is_subscriber DESC, joined_at ASC LIMIT ${limit}`;
  const stmt = db.prepare(query);
  return stmt.all();
}

function createLobbyWithEntries(entries) {
  if (!entries.length) {
    return null;
  }

  const db = getDatabase();
  const insertLobby = db.prepare(`INSERT INTO lobbies (status) VALUES ('forming')`);
  const insertLobbyPlayer = db.prepare(
    `INSERT INTO lobby_players (lobby_id, discord_id, username, display_name, position) VALUES (?, ?, ?, ?, ?)`,
  );
  const updateQueueStatus = db.prepare(`UPDATE queue_entries SET status = 'assigned' WHERE id = ?`);

  const lobbyInfo = insertLobby.run();
  const lobbyId = lobbyInfo.lastInsertRowid;

  entries.forEach((entry, index) => {
    insertLobbyPlayer.run(lobbyId, entry.discord_id, entry.username, entry.display_name, index + 1);
    updateQueueStatus.run(entry.id);
  });

  return lobbyId;
}

function assignLobbies() {
  let entries = selectWaitingEntries(4);

  while (entries.length === 4) {
    createLobbyWithEntries(entries);
    entries = selectWaitingEntries(4);
  }
}

function getLobbyPlayerInfo(discordId) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT
      l.id AS lobby_id,
      l.status AS lobby_status,
      lp.position AS position
    FROM lobby_players lp
    JOIN lobbies l ON l.id = lp.lobby_id
    WHERE lp.discord_id = ?
    LIMIT 1
  `);
  return stmt.get(discordId);
}

function getNextWaitingEntry() {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, discord_id, username, display_name, is_subscriber FROM queue_entries
    WHERE status = 'waiting'
    ORDER BY is_subscriber DESC, joined_at ASC
    LIMIT 1
  `);
  return stmt.get();
}

function removePlayerFromFormingLobby(discordId) {
  const db = getDatabase();
  const lobbyInfo = getLobbyPlayerInfo(discordId);
  if (!lobbyInfo) {
    return null;
  }

  if (lobbyInfo.lobby_status !== 'forming' && lobbyInfo.lobby_status !== 'open') {
    return { locked: true, status: lobbyInfo.lobby_status };
  }

  const deleteLobbyPlayer = db.prepare(`DELETE FROM lobby_players WHERE lobby_id = ? AND discord_id = ?`);
  const deleteQueueEntry = db.prepare(`DELETE FROM queue_entries WHERE discord_id = ? AND status = 'assigned'`);
  const insertLobbyPlayer = db.prepare(
    `INSERT INTO lobby_players (lobby_id, discord_id, username, display_name, position) VALUES (?, ?, ?, ?, ?)`,
  );
  const updateQueueStatus = db.prepare(`UPDATE queue_entries SET status = 'assigned' WHERE id = ?`);
  const selectRemainingPlayers = db.prepare(
    `SELECT id FROM lobby_players WHERE lobby_id = ? ORDER BY position ASC`,
  );
  const updatePosition = db.prepare(`UPDATE lobby_players SET position = ? WHERE id = ?`);

  deleteLobbyPlayer.run(lobbyInfo.lobby_id, discordId);
  deleteQueueEntry.run(discordId);

  const waitingEntry = getNextWaitingEntry();
  if (waitingEntry) {
    insertLobbyPlayer.run(
      lobbyInfo.lobby_id,
      waitingEntry.discord_id,
      waitingEntry.username,
      waitingEntry.display_name,
      lobbyInfo.position,
    );
    updateQueueStatus.run(waitingEntry.id);
  } else {
    const remainingPlayers = selectRemainingPlayers.all(lobbyInfo.lobby_id);
    let position = 1;
    for (const player of remainingPlayers) {
      updatePosition.run(position, player.id);
      position += 1;
    }
  }

  return { removed: true, lobbyId: lobbyInfo.lobby_id };
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
    queueEvents.emit('queueUpdated');
    return true;
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      return false;
    }
    throw error;
  }
}

function forceCreateLobby(limit = 4) {
  const entries = selectWaitingEntries(limit);
  if (!entries.length) {
    return null;
  }

  const lobbyId = createLobbyWithEntries(entries);
  if (lobbyId) {
    queueEvents.emit('queueUpdated');
  }

  return entries;
}

function removeFromQueue(discordId) {
  const db = getDatabase();
  const waitingStmt = db.prepare(`SELECT id FROM queue_entries WHERE discord_id = ? AND status = 'waiting'`);
  const waitingRow = waitingStmt.get(discordId);

  if (waitingRow) {
    const deleteStmt = db.prepare(`DELETE FROM queue_entries WHERE id = ?`);
    deleteStmt.run(waitingRow.id);
    queueEvents.emit('queueUpdated');
    return { success: true, type: 'waiting' };
  }

  const lobbyInfo = getLobbyPlayerInfo(discordId);
  if (!lobbyInfo) {
    return { success: false, reason: 'not_found' };
  }

  const removal = removePlayerFromFormingLobby(discordId);
  if (removal && removal.locked) {
    return { success: false, reason: 'locked' };
  }

  if (removal) {
    queueEvents.emit('queueUpdated');
    return { success: true, type: 'forming' };
  }

  return { success: false, reason: 'not_found' };
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
    `SELECT COUNT(1) AS count FROM queue_entries WHERE discord_id = ? AND status IN ('waiting', 'assigned')`,
  );
  const row = stmt.get(discordId);
  return row.count > 0;
}

function getActiveLobbies(status = null) {
  const db = getDatabase();
  const query = status
    ? `
    SELECT
      l.id AS lobby_id,
      l.status AS status,
      l.created_at AS created_at,
      lp.discord_id AS discord_id,
      lp.username AS username,
      lp.display_name AS display_name,
      qe.is_subscriber AS is_subscriber,
      lp.position AS position
    FROM lobbies l
    JOIN lobby_players lp ON lp.lobby_id = l.id
    LEFT JOIN queue_entries qe ON qe.discord_id = lp.discord_id
    WHERE l.status = ?
    ORDER BY l.id ASC, lp.position ASC
  `
    : `
    SELECT
      l.id AS lobby_id,
      l.status AS status,
      l.created_at AS created_at,
      lp.discord_id AS discord_id,
      lp.username AS username,
      lp.display_name AS display_name,
      qe.is_subscriber AS is_subscriber,
      lp.position AS position
    FROM lobbies l
    JOIN lobby_players lp ON lp.lobby_id = l.id
    LEFT JOIN queue_entries qe ON qe.discord_id = lp.discord_id
    ORDER BY l.id ASC, lp.position ASC
  `;
  const stmt = db.prepare(query);
  const rows = status ? stmt.all(status) : stmt.all();

  const lobbies = [];
  let currentLobby = null;

  for (const row of rows) {
    if (!currentLobby || currentLobby.id !== row.lobby_id) {
      currentLobby = {
        id: row.lobby_id,
        status: row.status,
        createdAt: row.created_at,
        players: [],
      };
      lobbies.push(currentLobby);
    }

    currentLobby.players.push({
      discordId: row.discord_id,
      username: row.username,
      displayName: row.display_name,
      isSubscriber: Boolean(row.is_subscriber),
      position: row.position,
    });
  }

  return lobbies;
}

function startLobby(lobbyId) {
  const db = getDatabase();
  const stmt = db.prepare(`UPDATE lobbies SET status = 'in_game' WHERE id = ? AND status IN ('forming', 'open')`);
  const info = stmt.run(lobbyId);
  if (info.changes === 0) {
    return false;
  }

  queueEvents.emit('queueUpdated');
  return true;
}

module.exports = {
  addToQueue,
  removeFromQueue,
  getQueue,
  isUserInQueue,
  getActiveLobbies,
  startLobby,
  forceCreateLobby,
};
