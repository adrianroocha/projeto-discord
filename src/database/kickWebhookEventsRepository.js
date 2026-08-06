const { getDatabase } = require('./sqliteClient');

function toNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Campo inválido: ${fieldName} é obrigatório.`);
  }
  return value.trim();
}

function toNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    return String(value);
  }

  const normalized = value.trim();
  return normalized || null;
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

function hasProcessed(eventMessageId, txDb) {
  const db = getDb(txDb);
  const id = toNonEmptyString(eventMessageId, 'eventMessageId');

  const row = db
    .prepare(
      `SELECT event_message_id
       FROM kick_webhook_events
       WHERE event_message_id = ?
       LIMIT 1`,
    )
    .get(id);

  return Boolean(row);
}

function registerProcessedEvent(data, txDb) {
  if (!data || typeof data !== 'object') {
    throw new Error('Parâmetro inválido: data é obrigatório.');
  }

  const db = getDb(txDb);
  const eventMessageId = toNonEmptyString(data.eventMessageId, 'eventMessageId');
  const eventSubscriptionId = toNullableString(data.eventSubscriptionId);
  const eventType = toNonEmptyString(data.eventType, 'eventType');
  const eventVersion = toNonEmptyString(data.eventVersion, 'eventVersion');
  const eventTimestamp = toNonEmptyString(data.eventTimestamp, 'eventTimestamp');
  const receivedAtMs = toTimestampMs(data.receivedAtMs, 'receivedAtMs');
  const processedAtMs = toTimestampMs(data.processedAtMs, 'processedAtMs');

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO kick_webhook_events (
        event_message_id,
        event_subscription_id,
        event_type,
        event_version,
        event_timestamp,
        received_at_ms,
        processed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventMessageId,
      eventSubscriptionId,
      eventType,
      eventVersion,
      eventTimestamp,
      receivedAtMs,
      processedAtMs,
    );

  return {
    recorded: result.changes > 0,
    reason: result.changes > 0 ? null : 'duplicate',
  };
}

function countAll(txDb) {
  const db = getDb(txDb);
  const row = db.prepare('SELECT COUNT(1) AS count FROM kick_webhook_events').get();
  return Number(row?.count || 0);
}

function findLatest(txDb) {
  const db = getDb(txDb);
  return (
    db
      .prepare(
        `SELECT event_message_id, event_subscription_id, event_type, event_version, event_timestamp, received_at_ms, processed_at_ms
         FROM kick_webhook_events
         ORDER BY received_at_ms DESC, event_message_id DESC
         LIMIT 1`,
      )
      .get() || null
  );
}

module.exports = {
  hasProcessed,
  registerProcessedEvent,
  countAll,
  findLatest,
};
