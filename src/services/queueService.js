const { getDatabase } = require('../database/sqliteClient');
const queueEvents = require('./queueEvents');

const LEAVE_COOLDOWN_SECONDS = 120;
const CANONICAL_QUEUE_ORDER =
  'COALESCE(admin_sort_priority_override, is_subscriber) DESC, COALESCE(queue_order_key, joined_at_ms) ASC, discord_id ASC';

const SWAP_ERROR_CODES = {
  INVALID_INPUT: 'INVALID_INPUT',
  SAME_USER: 'SAME_USER',
  PARTICIPANT_NOT_FOUND: 'PARTICIPANT_NOT_FOUND',
  LOBBY_IMMUTABLE: 'LOBBY_IMMUTABLE',
  LOBBY_STATE_CONFLICT: 'LOBBY_STATE_CONFLICT',
  QUEUE_POSITION_CONFLICT: 'QUEUE_POSITION_CONFLICT',
  LOBBY_POSITION_CONFLICT: 'LOBBY_POSITION_CONFLICT',
  SWAP_TRANSACTION_FAILED: 'SWAP_TRANSACTION_FAILED',
};

const LOBBY_REMOVE_ERROR_CODES = {
  INVALID_INPUT: 'INVALID_INPUT',
  LOBBY_PLAYER_NOT_FOUND: 'LOBBY_PLAYER_NOT_FOUND',
  LOBBY_IMMUTABLE: 'LOBBY_IMMUTABLE',
  LOBBY_STATE_CONFLICT: 'LOBBY_STATE_CONFLICT',
  REMOVE_TRANSACTION_FAILED: 'REMOVE_TRANSACTION_FAILED',
};

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
  const query = `
    SELECT
      id,
      discord_id,
      username,
      display_name,
      is_subscriber,
      joined_at_ms,
      queue_order_key,
      admin_sort_priority_override,
      COALESCE(admin_sort_priority_override, is_subscriber) AS effective_sort_priority
    FROM queue_entries
    ORDER BY ${CANONICAL_QUEUE_ORDER}
    LIMIT ${limit}
  `;
  const stmt = db.prepare(query);
  return stmt.all();
}

function getOrInitializeQueueOrderSequence(db) {
  const row = db.prepare('SELECT next_order_key FROM queue_order_sequence WHERE id = 1').get();
  if (row && Number.isSafeInteger(row.next_order_key) && row.next_order_key > 0) {
    return row.next_order_key;
  }

  const maxRow = db.prepare('SELECT COALESCE(MAX(queue_order_key), 0) AS max_key FROM queue_entries').get();
  const nextOrderKey = Math.max(1, Math.trunc(Number(maxRow?.max_key || 0)) + 1);

  if (!row) {
    db.prepare('INSERT INTO queue_order_sequence (id, next_order_key, updated_at_ms) VALUES (1, ?, ?)').run(
      nextOrderKey,
      Date.now(),
    );
  } else {
    db.prepare('UPDATE queue_order_sequence SET next_order_key = ?, updated_at_ms = ? WHERE id = 1').run(
      nextOrderKey,
      Date.now(),
    );
  }

  return nextOrderKey;
}

function allocateQueueOrderKeys(db, count = 1) {
  const safeCount = Math.max(1, Math.trunc(Number(count) || 1));
  const currentNext = getOrInitializeQueueOrderSequence(db);
  const nextSequenceValue = currentNext + safeCount;
  db.prepare('UPDATE queue_order_sequence SET next_order_key = ?, updated_at_ms = ? WHERE id = 1').run(
    nextSequenceValue,
    Date.now(),
  );

  return Array.from({ length: safeCount }, (_, index) => currentNext + index);
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
    `INSERT INTO lobbies (status, creation_type, lobby_number, created_at_ms, rebuild_locked) VALUES ('forming', ?, ?, ?, 0)`,
  );
  const insertLobbyPlayer = db.prepare(
    `INSERT INTO lobby_players (lobby_id, discord_id, username, display_name, position, original_joined_at_ms, original_queue_order_key, is_subscriber) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      entry.queue_order_key ?? entry.original_queue_order_key ?? null,
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
    `INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms, queue_order_key, admin_sort_priority_override) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
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
    const [queueOrderKey] = allocateQueueOrderKeys(db, 1);
    insertStmt.run(
      payload.discordId,
      payload.username,
      payload.displayName,
      snapshot.is_subscriber ? 1 : 0,
      joinedAtMs,
      queueOrderKey,
    );
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
    `INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms, queue_order_key, admin_sort_priority_override) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  );

  const transaction = db.transaction((payload) => {
    const allocatedOrderKeys = allocateQueueOrderKeys(db, payload.length || 1);
    for (const player of payload) {
      const queueOrderKey = allocatedOrderKeys.shift();
      const joinedAtMs = toTimestampMs(player.joinedAtMs ?? player.joinedAt ?? Date.now());
      const normalizedSubscriber = player.isSubscriber ? 1 : 0;
      insertSnapshotStmt.run(currentCycleId, player.discordId, normalizedSubscriber, joinedAtMs);
      insertStmt.run(
        player.discordId,
        player.username,
        player.displayName,
        normalizedSubscriber,
        joinedAtMs,
        queueOrderKey,
      );
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
    .prepare(
      `SELECT
        id,
        discord_id,
        username,
        display_name,
        is_subscriber,
        joined_at_ms,
        queue_order_key,
        admin_sort_priority_override,
        COALESCE(admin_sort_priority_override, is_subscriber) AS effective_sort_priority
      FROM queue_entries`,
    )
    .all();

  const lobbyPlayers = db
    .prepare(`
      SELECT
        lp.discord_id,
        lp.username,
        lp.display_name,
        lp.is_subscriber,
        lp.original_joined_at_ms,
        lp.original_queue_order_key
      FROM lobby_players lp
      JOIN lobbies l ON l.id = lp.lobby_id
      WHERE l.status = 'forming' AND l.creation_type = 'automatic' AND COALESCE(l.rebuild_locked, 0) = 0
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

    const originalQueueOrderKey = toTimestampMs(entry.original_queue_order_key ?? entry.queue_order_key);
    if (originalQueueOrderKey === null) {
      continue;
    }

    const effectiveSortPriority = normalizeSubscriberValue(
      entry.effective_sort_priority !== undefined
        ? entry.effective_sort_priority
        : entry.is_subscriber,
    );

    const existing = playerMap.get(entry.discord_id);
    if (!existing) {
      playerMap.set(entry.discord_id, {
        id: entry.id,
        discord_id: entry.discord_id,
        username: entry.username,
        display_name: entry.display_name,
        is_subscriber: entry.is_subscriber ? 1 : 0,
        effective_sort_priority: effectiveSortPriority,
        original_joined_at_ms: originalJoinedAtMs,
        original_queue_order_key: originalQueueOrderKey,
      });
      continue;
    }

    const existingSortPriority = existing.effective_sort_priority ? 1 : 0;
    const currentSortPriority = effectiveSortPriority ? 1 : 0;

    if (
      currentSortPriority > existingSortPriority ||
      (currentSortPriority === existingSortPriority && originalQueueOrderKey < existing.original_queue_order_key)
    ) {
      playerMap.set(entry.discord_id, {
        id: entry.id,
        discord_id: entry.discord_id,
        username: entry.username,
        display_name: entry.display_name,
        is_subscriber: entry.is_subscriber ? 1 : 0,
        effective_sort_priority: effectiveSortPriority,
        original_joined_at_ms: originalJoinedAtMs,
        original_queue_order_key: originalQueueOrderKey,
      });
    }
  }

  const sortedPlayers = Array.from(playerMap.values()).sort((a, b) => {
    const subscriberDiff = (b.effective_sort_priority ? 1 : 0) - (a.effective_sort_priority ? 1 : 0);
    if (subscriberDiff !== 0) {
      return subscriberDiff;
    }

    const queueOrderDiff = a.original_queue_order_key - b.original_queue_order_key;
    if (queueOrderDiff !== 0) {
      return queueOrderDiff;
    }

    return String(a.discord_id).localeCompare(String(b.discord_id));
  });

  const allExistingAutoForming = db
    .prepare(
      `SELECT id, lobby_number FROM lobbies WHERE status = 'forming' AND creation_type = 'automatic' AND COALESCE(rebuild_locked, 0) = 0 ORDER BY lobby_number ASC`,
    )
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
    `INSERT OR IGNORE INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms, queue_order_key, admin_sort_priority_override) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
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
      player.original_queue_order_key,
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
  const selectLockedFormingLobbies = db.prepare(`
    SELECT l.id AS lobby_id, l.creation_type AS creation_type
    FROM lobby_players lp
    JOIN lobbies l ON l.id = lp.lobby_id
    WHERE lp.discord_id = ? AND l.status = 'forming' AND COALESCE(l.rebuild_locked, 0) = 1
  `);
  const deleteForcedLobbyPlayer = db.prepare(`DELETE FROM lobby_players WHERE lobby_id = ? AND discord_id = ?`);
  const deleteLockedLobbyPlayer = db.prepare(`DELETE FROM lobby_players WHERE lobby_id = ? AND discord_id = ?`);
  const unlockLobbyRebuild = db.prepare(`UPDATE lobbies SET rebuild_locked = 0 WHERE id = ? AND status = 'forming'`);

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

    const lockedLobbies = selectLockedFormingLobbies.all(discordId);
    let removedFromLocked = 0;
    let removedFromLockedAutomatic = 0;
    for (const lobby of lockedLobbies) {
      deleteLockedLobbyPlayer.run(lobby.lobby_id, discordId);
      unlockLobbyRebuild.run(lobby.lobby_id);
      removedFromLocked += 1;
      if (lobby.creation_type === 'automatic') {
        removedFromLockedAutomatic += 1;
      }
    }

    const automaticForming = selectAutomaticFormingCount.get(discordId);
    let rebuilt = false;
    if ((automaticForming && automaticForming.count > 0) || removedFromLockedAutomatic > 0) {
      rebuildAutomaticFormingLobbies(discordId);
      rebuilt = true;
    }

    const success = removedFromQueue || removedFromForced || removedFromLocked || rebuilt;
    return { success, removedFromQueue, removedFromForced, removedFromLocked, rebuilt };
  });

  const result = transaction({ discordId });
  if (result.success) {
    queueEvents.emit('queueUpdated');
    return {
      success: true,
      removedFromQueue: result.removedFromQueue,
      removedFromForced: result.removedFromForced,
        removedFromLocked: result.removedFromLocked,
      rebuilt: result.rebuilt,
    };
  }

  return { success: false, reason: 'not_found' };
}

function getQueue() {
  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT
      id,
      discord_id,
      username,
      display_name,
      is_subscriber,
      joined_at_ms,
      queue_order_key,
      admin_sort_priority_override,
      COALESCE(admin_sort_priority_override, is_subscriber) AS effective_sort_priority
    FROM queue_entries
    ORDER BY ${CANONICAL_QUEUE_ORDER}`,
  );
  return stmt.all();
}

function getQueuePositionMap(db) {
  const rows = db.prepare(`SELECT discord_id FROM queue_entries ORDER BY ${CANONICAL_QUEUE_ORDER}`).all();
  const map = new Map();
  rows.forEach((row, index) => {
    map.set(row.discord_id, index + 1);
  });
  return map;
}

function normalizeSortPriority(value) {
  return value ? 1 : 0;
}

function calculateOverrideForTargetPriority(targetPriority, realPriority) {
  const safeTarget = normalizeSortPriority(targetPriority);
  const safeReal = normalizeSortPriority(realPriority);
  return safeTarget === safeReal ? null : safeTarget;
}

function buildQueueLocation(position) {
  return {
    state: 'queue',
    queuePosition: Number.isSafeInteger(position) ? position : null,
  };
}

function buildFormingLocation(row) {
  return {
    state: 'forming_lobby',
    lobbyId: row.lobby_id,
    lobbyNumber: row.lobby_number,
    slot: row.position,
  };
}

function swapParticipantsInCurrentCycle({ discordIdA, discordIdB, reason }) {
  const db = getDatabase();

  const normalizedDiscordIdA = String(discordIdA || '').trim();
  const normalizedDiscordIdB = String(discordIdB || '').trim();
  const normalizedReason = String(reason || '').trim();

  if (!normalizedDiscordIdA || !normalizedDiscordIdB || !normalizedReason || normalizedReason.length < 3 || normalizedReason.length > 200) {
    return { success: false, reason: SWAP_ERROR_CODES.INVALID_INPUT };
  }

  if (normalizedDiscordIdA === normalizedDiscordIdB) {
    return { success: false, reason: SWAP_ERROR_CODES.SAME_USER };
  }

  const selectQueueRowsByDiscordId = db.prepare(
    `SELECT
      id,
      discord_id,
      username,
      display_name,
      is_subscriber,
      joined_at_ms,
      queue_order_key,
      admin_sort_priority_override,
      COALESCE(admin_sort_priority_override, is_subscriber) AS effective_sort_priority
    FROM queue_entries
    WHERE discord_id = ?
    ORDER BY id ASC`,
  );
  const selectFormingRowsByDiscordId = db.prepare(
    `SELECT
      lp.id AS lobby_player_id,
      lp.lobby_id AS lobby_id,
      lp.discord_id AS discord_id,
      lp.username AS username,
      lp.display_name AS display_name,
      lp.position AS position,
      lp.original_joined_at_ms AS original_joined_at_ms,
      lp.original_queue_order_key AS original_queue_order_key,
      lp.is_subscriber AS is_subscriber,
      l.creation_type AS creation_type,
      l.lobby_number AS lobby_number,
      COALESCE(l.rebuild_locked, 0) AS rebuild_locked
    FROM lobby_players lp
    JOIN lobbies l ON l.id = lp.lobby_id
    WHERE lp.discord_id = ? AND l.status = 'forming'
    ORDER BY lp.id ASC`,
  );
  const selectInGameLobbyCount = db.prepare(
    `SELECT COUNT(1) AS count
    FROM lobby_players lp
    JOIN lobbies l ON l.id = lp.lobby_id
    WHERE lp.discord_id = ? AND l.status = 'in_game'`,
  );
  const selectQueueByOrderKey = db.prepare(
    'SELECT COUNT(1) AS count FROM queue_entries WHERE queue_order_key = ? AND discord_id <> ?',
  );
  const selectSlotCount = db.prepare('SELECT COUNT(1) AS count FROM lobby_players WHERE lobby_id = ? AND position = ?');
  const updateQueueOrderKeyAndOverride = db.prepare(
    'UPDATE queue_entries SET queue_order_key = ?, admin_sort_priority_override = ? WHERE id = ?',
  );
  const updateQueueOrderKeyOnly = db.prepare('UPDATE queue_entries SET queue_order_key = ? WHERE id = ?');
  const deleteQueueById = db.prepare('DELETE FROM queue_entries WHERE id = ?');
  const updateLobbyPlayerIdentity = db.prepare(
    `UPDATE lobby_players
     SET discord_id = ?,
         username = ?,
         display_name = ?,
         original_joined_at_ms = ?,
         original_queue_order_key = ?,
         is_subscriber = ?
     WHERE id = ?`,
  );
  const insertQueueEntry = db.prepare(
    `INSERT INTO queue_entries (
      discord_id,
      username,
      display_name,
      is_subscriber,
      joined_at_ms,
      queue_order_key,
      admin_sort_priority_override
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const lockRebuildForLobby = db.prepare('UPDATE lobbies SET rebuild_locked = 1 WHERE id = ? AND status = \'forming\'');

  function classifyParticipant(discordId) {
    const inGameCount = Number(selectInGameLobbyCount.get(discordId)?.count || 0);
    const queueRows = selectQueueRowsByDiscordId.all(discordId);
    const formingRows = selectFormingRowsByDiscordId.all(discordId);

    if (inGameCount > 0) {
      return { state: 'in_game', queueRows, formingRows, inGameCount };
    }

    if (queueRows.length === 0 && formingRows.length === 0) {
      return { state: 'not_participating', queueRows, formingRows, inGameCount };
    }

    if (queueRows.length === 1 && formingRows.length === 0) {
      return { state: 'queue', queueRows, formingRows, inGameCount, queueRow: queueRows[0] };
    }

    if (queueRows.length === 0 && formingRows.length === 1) {
      return { state: 'forming_lobby', queueRows, formingRows, inGameCount, formingRow: formingRows[0] };
    }

    return { state: 'state_conflict', queueRows, formingRows, inGameCount };
  }

  function validateQueueRow(queueRow) {
    if (!queueRow || !Number.isSafeInteger(queueRow.queue_order_key) || queueRow.queue_order_key <= 0) {
      return { valid: false, reason: SWAP_ERROR_CODES.QUEUE_POSITION_CONFLICT };
    }

    const queueOrderConflict = selectQueueByOrderKey.get(queueRow.queue_order_key, queueRow.discord_id);
    if (queueOrderConflict && queueOrderConflict.count > 0) {
      return { valid: false, reason: SWAP_ERROR_CODES.QUEUE_POSITION_CONFLICT };
    }

    return { valid: true };
  }

  function validateFormingRow(formingRow) {
    const slotCount = selectSlotCount.get(formingRow.lobby_id, formingRow.position);
    if (!slotCount || slotCount.count !== 1) {
      return { valid: false, reason: SWAP_ERROR_CODES.LOBBY_POSITION_CONFLICT };
    }

    return { valid: true };
  }

  const transaction = db.transaction((payload) => {
    const stateA = classifyParticipant(payload.discordIdA);
    const stateB = classifyParticipant(payload.discordIdB);

    if (stateA.state === 'in_game' || stateB.state === 'in_game') {
      return {
        success: false,
        reason: SWAP_ERROR_CODES.LOBBY_IMMUTABLE,
        stateA: stateA.state,
        stateB: stateB.state,
      };
    }

    if (stateA.state === 'not_participating' || stateB.state === 'not_participating') {
      return {
        success: false,
        reason: SWAP_ERROR_CODES.PARTICIPANT_NOT_FOUND,
        stateA: stateA.state,
        stateB: stateB.state,
      };
    }

    if (stateA.state === 'state_conflict' || stateB.state === 'state_conflict') {
      return {
        success: false,
        reason: SWAP_ERROR_CODES.LOBBY_STATE_CONFLICT,
        stateA: stateA.state,
        stateB: stateB.state,
      };
    }

    const supportedStates = new Set(['queue', 'forming_lobby']);
    if (!supportedStates.has(stateA.state) || !supportedStates.has(stateB.state)) {
      return {
        success: false,
        reason: SWAP_ERROR_CODES.LOBBY_STATE_CONFLICT,
        stateA: stateA.state,
        stateB: stateB.state,
      };
    }

    const queuePositionsBefore = getQueuePositionMap(db);
    const affectedLobbyRows = new Map();

    if (stateA.state === 'queue' && stateB.state === 'queue') {
      const rowA = stateA.queueRow;
      const rowB = stateB.queueRow;

      const queueAValidation = validateQueueRow(rowA);
      if (!queueAValidation.valid) {
        return { success: false, reason: queueAValidation.reason };
      }

      const queueBValidation = validateQueueRow(rowB);
      if (!queueBValidation.valid) {
        return { success: false, reason: queueBValidation.reason };
      }

      const keyA = rowA.queue_order_key;
      const keyB = rowB.queue_order_key;
      const overrideA = calculateOverrideForTargetPriority(rowB.effective_sort_priority, rowA.is_subscriber);
      const overrideB = calculateOverrideForTargetPriority(rowA.effective_sort_priority, rowB.is_subscriber);

      const tempA = updateQueueOrderKeyOnly.run(null, rowA.id);
      if (!tempA || tempA.changes !== 1) {
        return { success: false, reason: SWAP_ERROR_CODES.QUEUE_POSITION_CONFLICT };
      }

      const updateB = updateQueueOrderKeyAndOverride.run(keyA, overrideB, rowB.id);
      if (!updateB || updateB.changes !== 1) {
        return { success: false, reason: SWAP_ERROR_CODES.QUEUE_POSITION_CONFLICT };
      }

      const updateA = updateQueueOrderKeyAndOverride.run(keyB, overrideA, rowA.id);
      if (!updateA || updateA.changes !== 1) {
        return { success: false, reason: SWAP_ERROR_CODES.QUEUE_POSITION_CONFLICT };
      }
    } else if (stateA.state === 'forming_lobby' && stateB.state === 'forming_lobby') {
      const rowA = stateA.formingRow;
      const rowB = stateB.formingRow;

      const formingAValidation = validateFormingRow(rowA);
      if (!formingAValidation.valid) {
        return { success: false, reason: formingAValidation.reason };
      }

      const formingBValidation = validateFormingRow(rowB);
      if (!formingBValidation.valid) {
        return { success: false, reason: formingBValidation.reason };
      }

      const updateA = updateLobbyPlayerIdentity.run(
        rowB.discord_id,
        rowB.username,
        rowB.display_name,
        rowB.original_joined_at_ms,
        rowB.original_queue_order_key,
        rowB.is_subscriber ? 1 : 0,
        rowA.lobby_player_id,
      );
      if (!updateA || updateA.changes !== 1) {
        return { success: false, reason: SWAP_ERROR_CODES.LOBBY_POSITION_CONFLICT };
      }

      const updateB = updateLobbyPlayerIdentity.run(
        rowA.discord_id,
        rowA.username,
        rowA.display_name,
        rowA.original_joined_at_ms,
        rowA.original_queue_order_key,
        rowA.is_subscriber ? 1 : 0,
        rowB.lobby_player_id,
      );
      if (!updateB || updateB.changes !== 1) {
        return { success: false, reason: SWAP_ERROR_CODES.LOBBY_POSITION_CONFLICT };
      }

      affectedLobbyRows.set(rowA.lobby_id, rowA);
      affectedLobbyRows.set(rowB.lobby_id, rowB);
    } else {
      const formingState = stateA.state === 'forming_lobby' ? stateA : stateB;
      const queueState = stateA.state === 'queue' ? stateA : stateB;

      const lobbyPlayer = formingState.formingRow;
      const queuePlayer = queueState.queueRow;

      const queueValidation = validateQueueRow(queuePlayer);
      if (!queueValidation.valid) {
        return { success: false, reason: queueValidation.reason };
      }

      const formingValidation = validateFormingRow(lobbyPlayer);
      if (!formingValidation.valid) {
        return { success: false, reason: formingValidation.reason };
      }

      const removedQueueRow = deleteQueueById.run(queuePlayer.id);
      if (!removedQueueRow || removedQueueRow.changes !== 1) {
        return { success: false, reason: SWAP_ERROR_CODES.QUEUE_POSITION_CONFLICT };
      }

      const updatedLobbyPlayer = updateLobbyPlayerIdentity.run(
        queuePlayer.discord_id,
        queuePlayer.username,
        queuePlayer.display_name,
        queuePlayer.joined_at_ms,
        queuePlayer.queue_order_key,
        queuePlayer.is_subscriber ? 1 : 0,
        lobbyPlayer.lobby_player_id,
      );
      if (!updatedLobbyPlayer || updatedLobbyPlayer.changes !== 1) {
        return { success: false, reason: SWAP_ERROR_CODES.LOBBY_POSITION_CONFLICT };
      }

      const queueOverride = calculateOverrideForTargetPriority(
        queuePlayer.effective_sort_priority,
        lobbyPlayer.is_subscriber,
      );
      const insertedQueuePlayer = insertQueueEntry.run(
        lobbyPlayer.discord_id,
        lobbyPlayer.username,
        lobbyPlayer.display_name,
        lobbyPlayer.is_subscriber ? 1 : 0,
        lobbyPlayer.original_joined_at_ms,
        queuePlayer.queue_order_key,
        queueOverride,
      );
      if (!insertedQueuePlayer || insertedQueuePlayer.changes !== 1) {
        return { success: false, reason: SWAP_ERROR_CODES.QUEUE_POSITION_CONFLICT };
      }

      affectedLobbyRows.set(lobbyPlayer.lobby_id, lobbyPlayer);
    }

    const lockedLobbyIds = [];
    const lockedLobbyNumbers = [];
    for (const [lobbyId, lobbyRow] of affectedLobbyRows.entries()) {
      lockRebuildForLobby.run(lobbyId);
      lockedLobbyIds.push(lobbyId);
      lockedLobbyNumbers.push(lobbyRow.lobby_number);
    }

    const finalStateA = classifyParticipant(payload.discordIdA);
    const finalStateB = classifyParticipant(payload.discordIdB);

    if (finalStateA.state === 'state_conflict' || finalStateB.state === 'state_conflict') {
      return { success: false, reason: SWAP_ERROR_CODES.LOBBY_STATE_CONFLICT };
    }

    if (finalStateA.state === 'not_participating' || finalStateB.state === 'not_participating') {
      return { success: false, reason: SWAP_ERROR_CODES.SWAP_TRANSACTION_FAILED };
    }

    const queuePositionsAfter = getQueuePositionMap(db);

    const originA =
      stateA.state === 'queue'
        ? buildQueueLocation(queuePositionsBefore.get(payload.discordIdA))
        : buildFormingLocation(stateA.formingRow);
    const originB =
      stateB.state === 'queue'
        ? buildQueueLocation(queuePositionsBefore.get(payload.discordIdB))
        : buildFormingLocation(stateB.formingRow);

    const destinationA =
      finalStateA.state === 'queue'
        ? buildQueueLocation(queuePositionsAfter.get(payload.discordIdA))
        : buildFormingLocation(finalStateA.formingRow);
    const destinationB =
      finalStateB.state === 'queue'
        ? buildQueueLocation(queuePositionsAfter.get(payload.discordIdB))
        : buildFormingLocation(finalStateB.formingRow);

    return {
      success: true,
      reason: 'OK',
      userA: {
        discordId: payload.discordIdA,
        origin: originA,
        destination: destinationA,
      },
      userB: {
        discordId: payload.discordIdB,
        origin: originB,
        destination: destinationB,
      },
      lockedLobbyIds,
      lockedLobbyNumbers,
      affectedLobbyIds: Array.from(affectedLobbyRows.keys()),
      affectedLobbyNumbers: Array.from(new Set(Array.from(affectedLobbyRows.values()).map((row) => row.lobby_number))),
      reasonDetail: payload.reason,
    };
  });

  try {
    const result = transaction({
      discordIdA: normalizedDiscordIdA,
      discordIdB: normalizedDiscordIdB,
      reason: normalizedReason,
    });

    if (!result || result.success !== true) {
      return result || { success: false, reason: SWAP_ERROR_CODES.SWAP_TRANSACTION_FAILED };
    }

    queueEvents.emit('queueUpdated');
    return result;
  } catch {
    return { success: false, reason: SWAP_ERROR_CODES.SWAP_TRANSACTION_FAILED };
  }
}

function swapLobbyPlayerWithQueuePlayer({ lobbyDiscordId, queueDiscordId, reason }) {
  return swapParticipantsInCurrentCycle({
    discordIdA: lobbyDiscordId,
    discordIdB: queueDiscordId,
    reason,
  });
}

function removePlayerFromLobbyByDiscordId({ lobbyDiscordId, reason }) {
  const db = getDatabase();

  const normalizedLobbyDiscordId = String(lobbyDiscordId || '').trim();
  const normalizedReason = String(reason || '').trim();

  if (!normalizedLobbyDiscordId || !normalizedReason || normalizedReason.length < 3 || normalizedReason.length > 200) {
    return { success: false, reason: LOBBY_REMOVE_ERROR_CODES.INVALID_INPUT };
  }

  const selectInGameLobbyCount = db.prepare(
    `SELECT COUNT(1) AS count
     FROM lobby_players lp
     JOIN lobbies l ON l.id = lp.lobby_id
     WHERE lp.discord_id = ? AND l.status = 'in_game'`,
  );
  const selectFormingLobbyRows = db.prepare(
    `SELECT
      lp.id AS lobby_player_id,
      lp.lobby_id AS lobby_id,
      lp.discord_id AS discord_id,
      lp.position AS slot,
      lp.username AS username,
      lp.display_name AS display_name,
      lp.original_joined_at_ms AS original_joined_at_ms,
      lp.original_queue_order_key AS original_queue_order_key,
      lp.is_subscriber AS is_subscriber,
      l.status AS lobby_status,
      l.creation_type AS creation_type,
      l.lobby_number AS lobby_number,
      COALESCE(l.rebuild_locked, 0) AS rebuild_locked
    FROM lobby_players lp
    JOIN lobbies l ON l.id = lp.lobby_id
    WHERE lp.discord_id = ? AND l.status = 'forming'
    ORDER BY lp.id ASC`,
  );
  const selectQueueRowsByDiscordId = db.prepare(
    `SELECT id, admin_sort_priority_override
     FROM queue_entries
     WHERE discord_id = ?
     ORDER BY id ASC`,
  );
  const deleteLobbyPlayerById = db.prepare('DELETE FROM lobby_players WHERE id = ?');
  const deleteQueueById = db.prepare('DELETE FROM queue_entries WHERE id = ?');
  const unlockLobbyRebuild = db.prepare(
    'UPDATE lobbies SET rebuild_locked = 0 WHERE id = ? AND status = \'forming\' AND COALESCE(rebuild_locked, 0) = 1',
  );

  const transaction = db.transaction((payload) => {
    const inGameCount = selectInGameLobbyCount.get(payload.lobbyDiscordId);
    if (inGameCount && inGameCount.count > 0) {
      return { success: false, reason: LOBBY_REMOVE_ERROR_CODES.LOBBY_IMMUTABLE };
    }

    const formingRows = selectFormingLobbyRows.all(payload.lobbyDiscordId);
    if (!formingRows.length) {
      return { success: false, reason: LOBBY_REMOVE_ERROR_CODES.LOBBY_PLAYER_NOT_FOUND };
    }

    if (formingRows.length > 1) {
      return { success: false, reason: LOBBY_REMOVE_ERROR_CODES.LOBBY_STATE_CONFLICT };
    }

    const targetLobbyPlayer = formingRows[0];
    const removedLobbyPlayer = deleteLobbyPlayerById.run(targetLobbyPlayer.lobby_player_id);
    if (!removedLobbyPlayer || removedLobbyPlayer.changes !== 1) {
      return { success: false, reason: LOBBY_REMOVE_ERROR_CODES.LOBBY_STATE_CONFLICT };
    }

    const residualQueueRows = selectQueueRowsByDiscordId.all(payload.lobbyDiscordId);
    let removedQueueEntries = 0;
    let removedQueueOverrideEntries = 0;
    for (const row of residualQueueRows) {
      const removedQueueRow = deleteQueueById.run(row.id);
      if (!removedQueueRow || removedQueueRow.changes !== 1) {
        return { success: false, reason: LOBBY_REMOVE_ERROR_CODES.LOBBY_STATE_CONFLICT };
      }

      removedQueueEntries += 1;
      if (row.admin_sort_priority_override !== null && row.admin_sort_priority_override !== undefined) {
        removedQueueOverrideEntries += 1;
      }
    }

    let unlockedRebuild = false;
    if (targetLobbyPlayer.rebuild_locked === 1) {
      const unlocked = unlockLobbyRebuild.run(targetLobbyPlayer.lobby_id);
      if (!unlocked || unlocked.changes !== 1) {
        return { success: false, reason: LOBBY_REMOVE_ERROR_CODES.LOBBY_STATE_CONFLICT };
      }
      unlockedRebuild = true;
    }

    rebuildAutomaticFormingLobbies(payload.lobbyDiscordId);

    return {
      success: true,
      lobbyId: targetLobbyPlayer.lobby_id,
      lobbyNumber: targetLobbyPlayer.lobby_number,
      lobbyCreationType: targetLobbyPlayer.creation_type,
      slot: targetLobbyPlayer.slot,
      removedDiscordId: payload.lobbyDiscordId,
      removedQueueEntries,
      removedQueueOverrideEntries,
      unlockedRebuild,
      reason: payload.reason,
    };
  });

  try {
    const result = transaction({
      lobbyDiscordId: normalizedLobbyDiscordId,
      reason: normalizedReason,
    });

    if (!result || result.success !== true) {
      return result || { success: false, reason: LOBBY_REMOVE_ERROR_CODES.REMOVE_TRANSACTION_FAILED };
    }

    queueEvents.emit('queueUpdated');
    return result;
  } catch {
    return { success: false, reason: LOBBY_REMOVE_ERROR_CODES.REMOVE_TRANSACTION_FAILED };
  }
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
  swapParticipantsInCurrentCycle,
  swapLobbyPlayerWithQueuePlayer,
  removePlayerFromLobbyByDiscordId,
};
