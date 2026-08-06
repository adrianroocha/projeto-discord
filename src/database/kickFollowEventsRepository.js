const { getDatabase } = require('./sqliteClient');

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

function getDb(fromDb) {
  return fromDb || getDatabase();
}

function registerFollowEvent(data, txDb) {
  if (!data || typeof data !== 'object') {
    throw new Error('Parâmetro inválido: data é obrigatório.');
  }

  const db = getDb(txDb);
  const eventMessageId = toNonEmptyString(data.eventMessageId, 'eventMessageId');
  const broadcasterUserId = toNonEmptyString(data.broadcasterUserId, 'broadcasterUserId');
  const followerUserId = toNonEmptyString(data.followerUserId, 'followerUserId');
  const followerUsername = toNonEmptyString(data.followerUsername, 'followerUsername');
  const followedAtMs = toTimestampMs(data.followedAtMs, 'followedAtMs');
  const receivedAtMs = toTimestampMs(data.receivedAtMs, 'receivedAtMs');

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO kick_follow_events (
        event_message_id,
        broadcaster_user_id,
        follower_user_id,
        follower_username,
        followed_at_ms,
        received_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventMessageId,
      broadcasterUserId,
      followerUserId,
      followerUsername,
      followedAtMs,
      receivedAtMs,
    );

  return {
    recorded: result.changes > 0,
    reason: result.changes > 0 ? null : 'duplicate',
  };
}

function countAll(txDb) {
  const db = getDb(txDb);
  const row = db.prepare('SELECT COUNT(1) AS count FROM kick_follow_events').get();
  return Number(row?.count || 0);
}

function findLatest(txDb) {
  const db = getDb(txDb);
  return (
    db
      .prepare(
        `SELECT event_message_id, broadcaster_user_id, follower_user_id, follower_username, followed_at_ms, received_at_ms
         FROM kick_follow_events
         ORDER BY received_at_ms DESC, event_message_id DESC
         LIMIT 1`,
      )
      .get() || null
  );
}

function findByEventMessageId(eventMessageId, txDb) {
  const db = getDb(txDb);
  const id = toNonEmptyString(eventMessageId, 'eventMessageId');
  return (
    db
      .prepare(
        `SELECT event_message_id, broadcaster_user_id, follower_user_id, follower_username, followed_at_ms, received_at_ms
         FROM kick_follow_events
         WHERE event_message_id = ?
         LIMIT 1`,
      )
      .get(id) || null
  );
}

module.exports = {
  registerFollowEvent,
  countAll,
  findLatest,
  findByEventMessageId,
};
