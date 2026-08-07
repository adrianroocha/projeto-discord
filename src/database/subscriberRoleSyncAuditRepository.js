const { getDatabase } = require('./sqliteClient');

function toNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Campo inválido: ${fieldName} é obrigatório.`);
  }
  return value.trim();
}

function toFlag(value, fieldName) {
  if (value === 0 || value === 1) {
    return value;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  throw new Error(`Campo inválido: ${fieldName} deve ser booleano ou 0/1.`);
}

function toTimestampMs(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Campo inválido: ${fieldName} deve ser timestamp em milissegundos.`);
  }
  return Math.trunc(parsed);
}

function register(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Parâmetro inválido: entry é obrigatório.');
  }

  const db = getDatabase();

  const discordId = toNonEmptyString(entry.discordId, 'discordId');
  const eligible = toFlag(entry.eligible, 'eligible');
  const kickActive = toFlag(entry.kickActive, 'kickActive');
  const manualActive = toFlag(entry.manualActive, 'manualActive');
  const action = toNonEmptyString(entry.action, 'action');
  const result = toNonEmptyString(entry.result, 'result');
  const triggeredByDiscordId = toNonEmptyString(entry.triggeredByDiscordId, 'triggeredByDiscordId');
  const triggerType = toNonEmptyString(entry.triggerType, 'triggerType');
  const reason = toNonEmptyString(entry.reason, 'reason');
  const createdAtMs = toTimestampMs(entry.createdAtMs, 'createdAtMs');

  const insertResult = db.prepare(
    `INSERT INTO subscriber_role_sync_audit (
      discord_id,
      eligible,
      kick_active,
      manual_active,
      action,
      result,
      triggered_by_discord_id,
      trigger_type,
      reason,
      created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    discordId,
    eligible,
    kickActive,
    manualActive,
    action,
    result,
    triggeredByDiscordId,
    triggerType,
    reason,
    createdAtMs,
  );

  return db.prepare(
    `SELECT id, discord_id, eligible, kick_active, manual_active, action, result, triggered_by_discord_id, trigger_type, reason, created_at_ms
     FROM subscriber_role_sync_audit
     WHERE id = ?`,
  ).get(insertResult.lastInsertRowid);
}

function countAll() {
  const db = getDatabase();
  return db.prepare('SELECT COUNT(1) AS count FROM subscriber_role_sync_audit').get().count;
}

function findLatest() {
  const db = getDatabase();
  return (
    db
      .prepare(
        `SELECT id, discord_id, eligible, kick_active, manual_active, action, result, triggered_by_discord_id, trigger_type, reason, created_at_ms
         FROM subscriber_role_sync_audit
         ORDER BY created_at_ms DESC, id DESC
         LIMIT 1`,
      )
      .get() || null
  );
}

module.exports = {
  register,
  countAll,
  findLatest,
};
