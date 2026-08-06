const { getDatabase } = require('./sqliteClient');

const ALLOWED_SUBSCRIPTION_TYPES = new Set(['direct', 'gifted']);

function toNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Campo inválido: ${fieldName} é obrigatório.`);
  }
  return value.trim();
}

function toTimestampMs(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Campo inválido: ${fieldName} deve ser timestamp em milissegundos.`);
  }
  return Math.trunc(parsed);
}

function isoToTimestampMs(value, fieldName) {
  const raw = toNonEmptyString(value, fieldName);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Campo inválido: ${fieldName} deve ser data ISO válida.`);
  }
  return Math.trunc(parsed);
}

function getDb(fromDb) {
  return fromDb || getDatabase();
}

function findByBroadcasterAndKickUser(broadcasterUserId, kickUserId, txDb) {
  const db = getDb(txDb);
  const broadcasterId = toNonEmptyString(broadcasterUserId, 'broadcasterUserId');
  const subscriberId = toNonEmptyString(kickUserId, 'kickUserId');

  return (
    db
      .prepare(
        `SELECT broadcaster_user_id, kick_user_id, kick_username, subscription_type, started_at_ms, expires_at_ms, last_event_message_id, updated_at_ms
         FROM kick_subscriptions
         WHERE broadcaster_user_id = ? AND kick_user_id = ?
         LIMIT 1`,
      )
      .get(broadcasterId, subscriberId) || null
  );
}

function findActiveByKickUser(broadcasterUserId, kickUserId, nowMs, txDb) {
  const db = getDb(txDb);
  const broadcasterId = toNonEmptyString(broadcasterUserId, 'broadcasterUserId');
  const subscriberId = toNonEmptyString(kickUserId, 'kickUserId');
  const referenceNow = toTimestampMs(nowMs, 'nowMs');

  return (
    db
      .prepare(
        `SELECT broadcaster_user_id, kick_user_id, kick_username, subscription_type, started_at_ms, expires_at_ms, last_event_message_id, updated_at_ms
         FROM kick_subscriptions
         WHERE broadcaster_user_id = ? AND kick_user_id = ? AND expires_at_ms > ?
         LIMIT 1`,
      )
      .get(broadcasterId, subscriberId, referenceNow) || null
  );
}

function upsertFromEvent(data, txDb) {
  if (!data || typeof data !== 'object') {
    throw new Error('Parâmetro inválido: data é obrigatório.');
  }

  const db = getDb(txDb);
  const broadcasterUserId = toNonEmptyString(data.broadcasterUserId, 'broadcasterUserId');
  const kickUserId = toNonEmptyString(data.kickUserId, 'kickUserId');
  const kickUsername = toNonEmptyString(data.kickUsername, 'kickUsername');
  const subscriptionType = toNonEmptyString(data.subscriptionType, 'subscriptionType');
  const startedAtMs = isoToTimestampMs(data.startedAtIso, 'startedAtIso');
  const expiresAtMs = isoToTimestampMs(data.expiresAtIso, 'expiresAtIso');
  const lastEventMessageId = toNonEmptyString(data.lastEventMessageId, 'lastEventMessageId');
  const updatedAtMs = toTimestampMs(data.updatedAtMs, 'updatedAtMs');

  if (!ALLOWED_SUBSCRIPTION_TYPES.has(subscriptionType)) {
    throw new Error('Campo inválido: subscriptionType deve ser direct ou gifted.');
  }

  const existing = findByBroadcasterAndKickUser(broadcasterUserId, kickUserId, db);
  if (!existing) {
    db.prepare(
      `INSERT INTO kick_subscriptions (
        broadcaster_user_id,
        kick_user_id,
        kick_username,
        subscription_type,
        started_at_ms,
        expires_at_ms,
        last_event_message_id,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      broadcasterUserId,
      kickUserId,
      kickUsername,
      subscriptionType,
      startedAtMs,
      expiresAtMs,
      lastEventMessageId,
      updatedAtMs,
    );

    return findByBroadcasterAndKickUser(broadcasterUserId, kickUserId, db);
  }

  const nextStartedAtMs = Math.min(existing.started_at_ms, startedAtMs);
  const nextExpiresAtMs = Math.max(existing.expires_at_ms, expiresAtMs);

  db.prepare(
    `UPDATE kick_subscriptions
     SET kick_username = ?,
         subscription_type = ?,
         started_at_ms = ?,
         expires_at_ms = ?,
         last_event_message_id = ?,
         updated_at_ms = ?
     WHERE broadcaster_user_id = ? AND kick_user_id = ?`,
  ).run(
    kickUsername,
    subscriptionType,
    nextStartedAtMs,
    nextExpiresAtMs,
    lastEventMessageId,
    updatedAtMs,
    broadcasterUserId,
    kickUserId,
  );

  return findByBroadcasterAndKickUser(broadcasterUserId, kickUserId, db);
}

function findExpired(broadcasterUserId, nowMs, txDb) {
  const db = getDb(txDb);
  const broadcasterId = toNonEmptyString(broadcasterUserId, 'broadcasterUserId');
  const referenceNow = toTimestampMs(nowMs, 'nowMs');

  return db
    .prepare(
      `SELECT broadcaster_user_id, kick_user_id, kick_username, subscription_type, started_at_ms, expires_at_ms, last_event_message_id, updated_at_ms
       FROM kick_subscriptions
       WHERE broadcaster_user_id = ? AND expires_at_ms <= ?
       ORDER BY expires_at_ms ASC`,
    )
    .all(broadcasterId, referenceNow);
}

function isActive(broadcasterUserId, kickUserId, nowMs, txDb) {
  return Boolean(findActiveByKickUser(broadcasterUserId, kickUserId, nowMs, txDb));
}

module.exports = {
  findByBroadcasterAndKickUser,
  findActiveByKickUser,
  upsertFromEvent,
  findExpired,
  isActive,
};
