const { getDatabase } = require('../database/sqliteClient');
const queueEvents = require('./queueEvents');

const LEAVE_COOLDOWN_SECONDS = 120;

function toTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }

  return null;
}

function toLobbyNumber(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function selectWaitingEntries(limit = 4) {
  const db = getDatabase();
  const query = `SELECT id, discord_id, username, display_name, is_subscriber, joined_at_ms FROM queue_entries ORDER BY is_subscriber DESC, joined_at_ms ASC, discord_id ASC LIMIT ${limit}`;
  const stmt = db.prepare(query);
  return stmt.all();
}

function getCurrentQueueCycleId(db = getDatabase()) {
  const row = db.prepare(`SELECT current_cycle_id FROM queue_cycle_state WHERE id = 1`).get();
  if (!row || typeof row.current_cycle_id !== 'number') {
    return 1;
  }

  return row.current_cycle_id;
}

function getPrioritySnapshot(db, cycleId, discordId) {
  return db
    .prepare(
      `SELECT cycle_id, discord_id, is_subscriber, created_at_ms FROM queue_priority_snapshots WHERE cycle_id = ? AND discord_id = ?`,
    )
    .get(cycleId, discordId);
}

function normalizeSubscriberValue(value) {
  return value ? 1 : 0;
}

function resolveSubscriberForSnapshot(discordId, resolvePrioritySnapshot, fallbackIsSubscriber) {
  if (typeof resolvePrioritySnapshot !== 'function') {
    return {
      isSubscriber: normalizeSubscriberValue(fallbackIsSubscriber),
      source: 'provided',
      reliable: true,
    };
  }

  try {
    const resolved = resolvePrioritySnapshot({ discordId });
    return {
      isSubscriber: normalizeSubscriberValue(resolved?.isSubscriber),
      source: resolved?.source || 'eligibility',
      reliable: resolved?.reliable !== false,
    };
  } catch (_error) {
    return {
      isSubscriber: 0,
      source: 'eligibility_error',
      reliable: false,
    };
  }
}

function createLobbyWithEntries(entries, creationType = 'automatic', lobbyNumber = null) {
  if (!entries.length) {
    return null;
  }

  const db = getDatabase();
  const insertLobby = db.prepare(
    `INSERT INTO lobbies (status, creation_type, lobby_number, created_at_ms) VALUES ('forming', ?, ?, ?)`,
  );
  const insertLobbyPlayer = db.prepare(
    `INSERT INTO lobby_players (lobby_id, discord_id, username, display_name, position, original_joined_at_ms, is_subscriber) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteQueueEntry = db.prepare(`DELETE FROM queue_entries WHERE id = ?`);

  const assignedLobbyNumber = lobbyNumber || getNextLobbyNumber();
  const lobbyInfo = insertLobby.run(creationType, assignedLobbyNumber, Date.now());
  const lobbyId = lobbyInfo.lastInsertRowid;

  entries.forEach((entry, index) => {
    const originalJoinedAtMs = toTimestampMs(entry.original_joined_at_ms ?? entry.joined_at_ms ?? Date.now());
    insertLobbyPlayer.run(
      lobbyId,
      entry.discord_id,
      entry.username,
      entry.display_name,
      index + 1,
      originalJoinedAtMs,
      entry.is_subscriber ? 1 : 0,
    );

    if (entry.id) {
      deleteQueueEntry.run(entry.id);
    }
  });

  return { lobbyId, lobbyNumber: assignedLobbyNumber };
}

function assignLobbies() {
  let entries = selectWaitingEntries(4);

  while (entries.length === 4) {
    createLobbyWithEntries(entries, 'automatic');
    entries = selectWaitingEntries(4);
  }
}

function getLobbyPlayerInfo(discordId) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT
      l.id AS lobby_id,
      l.status AS lobby_status,
      lp.position AS position,
      l.creation_type AS creation_type
    FROM lobby_players lp
    JOIN lobbies l ON l.id = lp.lobby_id
    WHERE lp.discord_id = ?
    LIMIT 1
  `);
  return stmt.get(discordId);
}

function getNextLobbyNumber(reservedNumbers = []) {
  const db = getDatabase();
  const rows = db.prepare(`SELECT lobby_number FROM lobbies`).all();
  const reserved = new Set(reservedNumbers);
  rows.forEach((row) => {
    if (row.lobby_number) {
      reserved.add(row.lobby_number);
    }
  });

  let next = 1;
  while (reserved.has(next)) {
    next += 1;
  }
  return next;
}

function getNextWaitingEntry() {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, discord_id, username, display_name, is_subscriber, joined_at_ms FROM queue_entries
    ORDER BY is_subscriber DESC, joined_at_ms ASC, discord_id ASC
    LIMIT 1
  `);
  return stmt.get();
}

function getLeaveCooldown(discordId) {
  const db = getDatabase();

  if (process.env.NODE_ENV === 'development' && /^test-user-/.test(discordId)) {
    return { canLeave: true, remainingSeconds: 0 };
  }

  const queueEntry = db
    .prepare(`SELECT joined_at_ms FROM queue_entries WHERE discord_id = ?`)
    .get(discordId);

  const formingLobbyEntry = db
    .prepare(`
      SELECT lp.original_joined_at_ms AS joined_at_ms
      FROM lobby_players lp
      JOIN lobbies l ON l.id = lp.lobby_id
      WHERE lp.discord_id = ? AND l.status = 'forming'
      ORDER BY lp.id DESC
      LIMIT 1
    `)
    .get(discordId);

  let referenceTimestampMs = null;
  if (queueEntry) {
    referenceTimestampMs = queueEntry.joined_at_ms;
  } else if (formingLobbyEntry) {
    referenceTimestampMs = formingLobbyEntry.joined_at_ms;
  }

  const originalJoinedAtMs = toTimestampMs(referenceTimestampMs);
  if (originalJoinedAtMs === null) {
    return { canLeave: true, remainingSeconds: 0 };
  }

  const elapsedSeconds = Math.floor((Date.now() - originalJoinedAtMs) / 1000);
  const remainingSeconds = Math.max(0, LEAVE_COOLDOWN_SECONDS - elapsedSeconds);

  if (remainingSeconds === 0) {
    return { canLeave: true, remainingSeconds: 0 };
  }

  return { canLeave: false, remainingSeconds };
}

function removePlayerFromFormingLobby(discordId) {
  const db = getDatabase();
  const lobbyInfo = getLobbyPlayerInfo(discordId);
  if (!lobbyInfo) {
    return null;
  }

  if (lobbyInfo.lobby_status !== 'forming') {
    return { locked: true, status: lobbyInfo.lobby_status };
  }

  const deleteLobbyPlayer = db.prepare(`DELETE FROM lobby_players WHERE lobby_id = ? AND discord_id = ?`);
  const insertLobbyPlayer = db.prepare(
    `INSERT INTO lobby_players (lobby_id, discord_id, username, display_name, position, original_joined_at_ms, is_subscriber) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteQueueById = db.prepare(`DELETE FROM queue_entries WHERE id = ?`);
  const selectRemainingPlayers = db.prepare(`SELECT id FROM lobby_players WHERE lobby_id = ? ORDER BY position ASC`);
  const updatePosition = db.prepare(`UPDATE lobby_players SET position = ? WHERE id = ?`);
  const getCreationTypeStmt = db.prepare(`SELECT creation_type FROM lobbies WHERE id = ?`);

  deleteLobbyPlayer.run(lobbyInfo.lobby_id, discordId);

  const lt = getCreationTypeStmt.get(lobbyInfo.lobby_id);
  const creationType = lt ? lt.creation_type : 'automatic';

  if (creationType === 'automatic') {
    const waitingEntry = getNextWaitingEntry();
    if (waitingEntry) {
      insertLobbyPlayer.run(
        lobbyInfo.lobby_id,
        waitingEntry.discord_id,
        waitingEntry.username,
        waitingEntry.display_name,
        lobbyInfo.position,
        waitingEntry.joined_at_ms,
        waitingEntry.is_subscriber ? 1 : 0,
      );

      if (waitingEntry.id) {
        deleteQueueById.run(waitingEntry.id);
      }
    }
  }

  const remainingPlayers = selectRemainingPlayers.all(lobbyInfo.lobby_id);
  let position = 1;
  for (const player of remainingPlayers) {
    updatePosition.run(position, player.id);
    position += 1;
  }

  return { removed: true, lobbyId: lobbyInfo.lobby_id };
}

function addToQueue({ discordId, username, displayName, isSubscriber = 0, resolvePrioritySnapshot = null }) {
  const db = getDatabase();

  const selectAlreadyWaiting = db.prepare(`SELECT id FROM queue_entries WHERE discord_id = ?`);
  const selectInForming = db.prepare(
    `SELECT l.id FROM lobby_players lp JOIN lobbies l ON l.id = lp.lobby_id WHERE lp.discord_id = ? AND l.status = 'forming' LIMIT 1`,
  );
  const insertSnapshotStmt = db.prepare(
    `INSERT OR IGNORE INTO queue_priority_snapshots (cycle_id, discord_id, is_subscriber, created_at_ms) VALUES (?, ?, ?, ?)`,
  );

  const insertStmt = db.prepare(
    `INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms) VALUES (?, ?, ?, ?, ?)`,
  );

  const transaction = db.transaction((payload) => {
    const alreadyWaiting = selectAlreadyWaiting.get(payload.discordId);
    if (alreadyWaiting) {
      return { success: false, reason: 'already_waiting' };
    }

    const inForming = selectInForming.get(payload.discordId);
    if (inForming) {
      return { success: false, reason: 'in_forming_lobby' };
    }

    const currentCycleId = getCurrentQueueCycleId(db);
    let snapshot = getPrioritySnapshot(db, currentCycleId, payload.discordId);
    let snapshotStatus = 'reused';
    let snapshotResolution = {
      source: 'existing_snapshot',
      reliable: true,
    };

    if (!snapshot) {
      snapshotStatus = 'created';
      snapshotResolution = resolveSubscriberForSnapshot(
        payload.discordId,
        payload.resolvePrioritySnapshot,
        payload.isSubscriber,
      );

      insertSnapshotStmt.run(
        currentCycleId,
        payload.discordId,
        snapshotResolution.isSubscriber,
        Date.now(),
      );
      snapshot = getPrioritySnapshot(db, currentCycleId, payload.discordId);
    }

    const joinedAtMs = Date.now();
    insertStmt.run(payload.discordId, payload.username, payload.displayName, snapshot.is_subscriber ? 1 : 0, joinedAtMs);
    rebuildAutomaticFormingLobbies(null);
    return {
      success: true,
      joinedLobby: false,
      isSubscriber: snapshot.is_subscriber ? 1 : 0,
      snapshotStatus,
      snapshotResolution,
      joinedAtMs,
      cycleId: currentCycleId,
    };
  });

  try {
    const result = transaction({ discordId, username, displayName, isSubscriber, resolvePrioritySnapshot });
    if (result && result.success === false) {
      return result;
    }

    queueEvents.emit('queueUpdated');
    return result;
  } catch (error) {
    if (error.message && error.message.includes('UNIQUE')) {
      return { success: false, reason: 'already_waiting' };
    }
    throw error;
  }
}

function addMultipleToQueue(entries) {
  const db = getDatabase();
  const currentCycleId = getCurrentQueueCycleId(db);
  const insertSnapshotStmt = db.prepare(
    `INSERT OR IGNORE INTO queue_priority_snapshots (cycle_id, discord_id, is_subscriber, created_at_ms) VALUES (?, ?, ?, ?)`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms) VALUES (?, ?, ?, ?, ?)`,
  );

  const transaction = db.transaction((payload) => {
    for (const player of payload) {
      const joinedAtMs = toTimestampMs(player.joinedAtMs ?? player.joinedAt ?? Date.now());
      const normalizedSubscriber = player.isSubscriber ? 1 : 0;
      insertSnapshotStmt.run(currentCycleId, player.discordId, normalizedSubscriber, joinedAtMs);
      insertStmt.run(player.discordId, player.username, player.displayName, normalizedSubscriber, joinedAtMs);
    }

    rebuildAutomaticFormingLobbies(null);
  });

  const result = transaction(entries);
  queueEvents.emit('queueUpdated');
  return result;
}

function forceCreateLobby(limit = 4) {
  const db = getDatabase();
  const entries = selectWaitingEntries(limit);
  if (!entries.length) {
    return { success: false, available: 0 };
  }

  if (entries.length < limit) {
    return { success: false, available: entries.length };
  }

  const transaction = db.transaction(() => {
    return createLobbyWithEntries(entries, 'forced');
  });

  const createdLobby = transaction();
  queueEvents.emit('queueUpdated');
  return {
    success: true,
    entries,
    lobbyId: createdLobby ? createdLobby.lobbyId : null,
    lobbyNumber: createdLobby ? createdLobby.lobbyNumber : null,
  };
}

function rebuildAutomaticFormingLobbies(excludedDiscordId) {
  const db = getDatabase();

  const queueEntries = db
    .prepare(`SELECT id, discord_id, username, display_name, is_subscriber, joined_at_ms FROM queue_entries`)
    .all();

  const lobbyPlayers = db
    .prepare(`
      SELECT lp.discord_id, lp.username, lp.display_name, lp.is_subscriber, lp.original_joined_at_ms
      FROM lobby_players lp
      JOIN lobbies l ON l.id = lp.lobby_id
      WHERE l.status = 'forming' AND l.creation_type = 'automatic'
    `)
    .all();

  const playerMap = new Map();

  for (const entry of [...queueEntries, ...lobbyPlayers]) {
    if (entry.discord_id === excludedDiscordId) {
      continue;
    }

    const originalJoinedAtMs = toTimestampMs(entry.original_joined_at_ms ?? entry.joined_at_ms);
    if (originalJoinedAtMs === null) {
      continue;
    }

    const existing = playerMap.get(entry.discord_id);
    if (!existing) {
      playerMap.set(entry.discord_id, {
        id: entry.id,
        discord_id: entry.discord_id,
        username: entry.username,
        display_name: entry.display_name,
        is_subscriber: entry.is_subscriber ? 1 : 0,
        original_joined_at_ms: originalJoinedAtMs,
      });
      continue;
    }

    const existingSubscriber = existing.is_subscriber ? 1 : 0;
    const currentSubscriber = entry.is_subscriber ? 1 : 0;

    if (
      currentSubscriber > existingSubscriber ||
      (currentSubscriber === existingSubscriber && originalJoinedAtMs < existing.original_joined_at_ms)
    ) {
      playerMap.set(entry.discord_id, {
        id: entry.id,
        discord_id: entry.discord_id,
        username: entry.username,
        display_name: entry.display_name,
        is_subscriber: entry.is_subscriber ? 1 : 0,
        original_joined_at_ms: originalJoinedAtMs,
      });
    }
  }

  const sortedPlayers = Array.from(playerMap.values()).sort((a, b) => {
    const subscriberDiff = (b.is_subscriber ? 1 : 0) - (a.is_subscriber ? 1 : 0);
    if (subscriberDiff !== 0) {
      return subscriberDiff;
    }

    const timestampDiff = a.original_joined_at_ms - b.original_joined_at_ms;
    if (timestampDiff !== 0) {
      return timestampDiff;
    }

    return String(a.discord_id).localeCompare(String(b.discord_id));
  });

  const allExistingAutoForming = db
    .prepare(`SELECT id, lobby_number FROM lobbies WHERE status = 'forming' AND creation_type = 'automatic' ORDER BY lobby_number ASC`)
    .all();

  const autoFormingLobbyIds = allExistingAutoForming.map((row) => row.id);
  const existingAutoLobbyNumbers = allExistingAutoForming.map((row) => row.lobby_number);
  const targetLobbyCount = Math.floor(sortedPlayers.length / 4);
  const preservedNumbers = existingAutoLobbyNumbers.slice(0, targetLobbyCount);

  const reservedOtherLobbyNumbers = db
    .prepare(`SELECT lobby_number FROM lobbies WHERE NOT (status = 'forming' AND creation_type = 'automatic')`)
    .all()
    .map((row) => row.lobby_number);

  const reservedNumbers = new Set([...reservedOtherLobbyNumbers, ...preservedNumbers]);
  const lobbyNumbersToUse = [...preservedNumbers];

  while (lobbyNumbersToUse.length < targetLobbyCount) {
    const nextNumber = getNextLobbyNumber([...reservedNumbers]);
    lobbyNumbersToUse.push(nextNumber);
    reservedNumbers.add(nextNumber);
  }

  if (autoFormingLobbyIds.length) {
    const lobbyIdsPlaceholder = autoFormingLobbyIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM lobby_players WHERE lobby_id IN (${lobbyIdsPlaceholder})`).run(...autoFormingLobbyIds);
    db.prepare(`DELETE FROM lobbies WHERE id IN (${lobbyIdsPlaceholder})`).run(...autoFormingLobbyIds);
  }

  const completeGroups = [];
  for (let index = 0; index + 4 <= sortedPlayers.length; index += 4) {
    completeGroups.push(sortedPlayers.slice(index, index + 4));
  }

  completeGroups.forEach((group, index) => {
    createLobbyWithEntries(group, 'automatic', lobbyNumbersToUse[index]);
  });

  const insertQueueEntry = db.prepare(
    `INSERT OR IGNORE INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms) VALUES (?, ?, ?, ?, ?)`,
  );
  const currentCycleId = getCurrentQueueCycleId(db);
  const insertSnapshotStmt = db.prepare(
    `INSERT OR IGNORE INTO queue_priority_snapshots (cycle_id, discord_id, is_subscriber, created_at_ms) VALUES (?, ?, ?, ?)`,
  );

  const leftoverPlayers = sortedPlayers.slice(completeGroups.length * 4);
  leftoverPlayers.forEach((player) => {
    if (player.id) {
      return;
    }

    insertSnapshotStmt.run(
      currentCycleId,
      player.discord_id,
      player.is_subscriber ? 1 : 0,
      player.original_joined_at_ms,
    );

    insertQueueEntry.run(
      player.discord_id,
      player.username,
      player.display_name,
      player.is_subscriber ? 1 : 0,
      player.original_joined_at_ms,
    );
  });
}

function removeFromQueue(discordId) {
  const db = getDatabase();

  const cooldown = getLeaveCooldown(discordId);
  if (!cooldown.canLeave) {
    return { success: false, reason: 'cooldown', remainingSeconds: cooldown.remainingSeconds };
  }

  const selectQueueEntryStmt = db.prepare(`SELECT id FROM queue_entries WHERE discord_id = ?`);
  const deleteQueueById = db.prepare(`DELETE FROM queue_entries WHERE id = ?`);
  const selectForcedFormingLobbies = db.prepare(`
    SELECT l.id AS lobby_id
    FROM lobby_players lp
    JOIN lobbies l ON l.id = lp.lobby_id
    WHERE lp.discord_id = ? AND l.status = 'forming' AND l.creation_type = 'forced'
  `);
  const selectAutomaticFormingCount = db.prepare(`
    SELECT COUNT(DISTINCT l.id) AS count
    FROM lobby_players lp
    JOIN lobbies l ON l.id = lp.lobby_id
    WHERE lp.discord_id = ? AND l.status = 'forming' AND l.creation_type = 'automatic'
  `);
  const deleteForcedLobbyPlayer = db.prepare(`DELETE FROM lobby_players WHERE lobby_id = ? AND discord_id = ?`);

  const transaction = db.transaction((payload) => {
    const { discordId } = payload;

    const waitingRow = selectQueueEntryStmt.get(discordId);
    const removedFromQueue = !!waitingRow;
    if (waitingRow) {
      deleteQueueById.run(waitingRow.id);
    }

    const forcedLobbies = selectForcedFormingLobbies.all(discordId);
    let removedFromForced = 0;
    for (const lobby of forcedLobbies) {
      deleteForcedLobbyPlayer.run(lobby.lobby_id, discordId);
      removedFromForced += 1;
    }

    const automaticForming = selectAutomaticFormingCount.get(discordId);
    let rebuilt = false;
    if (automaticForming && automaticForming.count > 0) {
      rebuildAutomaticFormingLobbies(discordId);
      rebuilt = true;
    }

    const success = removedFromQueue || removedFromForced || rebuilt;
    return { success, removedFromQueue, removedFromForced, rebuilt };
  });

  const result = transaction({ discordId });
  if (result.success) {
    queueEvents.emit('queueUpdated');
    return {
      success: true,
      removedFromQueue: result.removedFromQueue,
      removedFromForced: result.removedFromForced,
      rebuilt: result.rebuilt,
    };
  }

  return { success: false, reason: 'not_found' };
}

function getQueue() {
  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT id, discord_id, username, display_name, is_subscriber, joined_at_ms FROM queue_entries ORDER BY is_subscriber DESC, joined_at_ms ASC, discord_id ASC`,
  );
  return stmt.all();
}

function isUserInQueue(discordId) {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT COUNT(1) AS count FROM queue_entries WHERE discord_id = ?`);
  const row = stmt.get(discordId);
  return row.count > 0;
}

function getActiveLobbies(status = null) {
  const db = getDatabase();
  const query = status
    ? `
    SELECT
      l.id AS lobby_id,
      l.lobby_number AS lobby_number,
      l.status AS status,
      l.creation_type AS creation_type,
      l.created_at_ms AS created_at_ms,
      lp.discord_id AS discord_id,
      lp.username AS username,
      lp.display_name AS display_name,
      lp.is_subscriber AS is_subscriber,
      lp.position AS position
    FROM lobbies l
    JOIN lobby_players lp ON lp.lobby_id = l.id
    WHERE l.status = ?
    ORDER BY l.lobby_number ASC, lp.position ASC
  `
    : `
    SELECT
      l.id AS lobby_id,
      l.lobby_number AS lobby_number,
      l.status AS status,
      l.created_at_ms AS created_at_ms,
      l.creation_type AS creation_type,
      lp.discord_id AS discord_id,
      lp.username AS username,
      lp.display_name AS display_name,
      lp.is_subscriber AS is_subscriber,
      lp.position AS position
    FROM lobbies l
    JOIN lobby_players lp ON lp.lobby_id = l.id
    ORDER BY l.lobby_number ASC, lp.position ASC
  `;
  const stmt = db.prepare(query);
  const rows = status ? stmt.all(status) : stmt.all();

  const lobbies = [];
  let currentLobby = null;

  for (const row of rows) {
    if (!currentLobby || currentLobby.id !== row.lobby_id) {
      currentLobby = {
        id: row.lobby_id,
        lobbyNumber: row.lobby_number,
        status: row.status,
        createdAtMs: row.created_at_ms,
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

function startLobbyByNumber(lobbyNumber) {
  const db = getDatabase();
  const safeLobbyNumber = toLobbyNumber(lobbyNumber);
  if (safeLobbyNumber === null) {
    return false;
  }

  const selectIds = db.prepare(`SELECT id FROM lobbies WHERE lobby_number = ? AND status IN ('forming', 'open') ORDER BY id ASC`);
  const updateById = db.prepare(`UPDATE lobbies SET status = 'in_game' WHERE id = ? AND status IN ('forming', 'open')`);
  const transaction = db.transaction((targetLobbyNumber) => {
    const rows = selectIds.all(targetLobbyNumber);

    if (rows.length !== 1) {
      return false;
    }

    const info = updateById.run(rows[0].id);
    if (info.changes !== 1) {
      throw new Error('LOBBY_START_UPDATE_FAILED');
    }

    return true;
  });

  let started = false;
  try {
    started = transaction(safeLobbyNumber);
  } catch {
    return false;
  }

  if (!started) {
    return false;
  }

  queueEvents.emit('queueUpdated');
  return true;
}

function resetQueueCycle() {
  const db = getDatabase();
  const deleteLobbyPlayers = db.prepare(`DELETE FROM lobby_players`);
  const deleteLobbies = db.prepare(`DELETE FROM lobbies`);
  const deleteQueueEntries = db.prepare(`DELETE FROM queue_entries`);
  const deleteQueuePrioritySnapshots = db.prepare(`DELETE FROM queue_priority_snapshots`);
  const incrementCycleId = db.prepare(
    `UPDATE queue_cycle_state SET current_cycle_id = current_cycle_id + 1, updated_at_ms = ? WHERE id = 1`,
  );

  const transaction = db.transaction(() => {
    deleteLobbyPlayers.run();
    deleteLobbies.run();
    deleteQueueEntries.run();
    deleteQueuePrioritySnapshots.run();
    incrementCycleId.run(Date.now());
  });

  transaction();
  return true;
}

function clearTestData() {
  const db = getDatabase();
  const currentCycleId = getCurrentQueueCycleId(db);
  const deleteQueueEntries = db.prepare(`DELETE FROM queue_entries WHERE discord_id LIKE 'test-user-%'`);
  const deleteLobbyPlayers = db.prepare(`DELETE FROM lobby_players WHERE discord_id LIKE 'test-user-%'`);
  const deleteSnapshots = db.prepare(
    `DELETE FROM queue_priority_snapshots WHERE cycle_id = ? AND discord_id LIKE 'test-user-%'`,
  );
  const selectEmptyLobbies = db.prepare(`SELECT id FROM lobbies WHERE id NOT IN (SELECT DISTINCT lobby_id FROM lobby_players)`);
  const deleteEmptyLobbies = db.prepare(`DELETE FROM lobbies WHERE id = ?`);

  const transaction = db.transaction(() => {
    deleteQueueEntries.run();
    deleteLobbyPlayers.run();
    deleteSnapshots.run(currentCycleId);

    const emptyLobbies = selectEmptyLobbies.all();
    for (const lobby of emptyLobbies) {
      deleteEmptyLobbies.run(lobby.id);
    }

    rebuildAutomaticFormingLobbies(null);
  });

  transaction();
  queueEvents.emit('queueUpdated');
  return true;
}

module.exports = {
  addToQueue,
  addMultipleToQueue,
  removeFromQueue,
  getLeaveCooldown,
  getQueue,
  isUserInQueue,
  getActiveLobbies,
  startLobby,
  startLobbyByNumber,
  forceCreateLobby,
  resetQueueCycle,
  clearTestData,
  getCurrentQueueCycleId,
};
