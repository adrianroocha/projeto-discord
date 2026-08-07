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

function toNonNegativeInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Campo inválido: ${fieldName} deve ser inteiro não negativo.`);
  }
  return parsed;
}

function registerStarted(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Parâmetro inválido: entry é obrigatório.');
  }

  const db = getDatabase();
  const triggerType = toNonEmptyString(entry.triggerType, 'triggerType');
  const triggeredByDiscordId = toNullableString(entry.triggeredByDiscordId);
  const reason = toNonEmptyString(entry.reason, 'reason');
  const startedAtMs = toTimestampMs(entry.startedAtMs, 'startedAtMs');

  const result = db
    .prepare(
      `INSERT INTO subscriber_role_reconciliation_runs (
        trigger_type,
        triggered_by_discord_id,
        reason,
        started_at_ms,
        status
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .run(triggerType, triggeredByDiscordId, reason, startedAtMs, 'running');

  return result.lastInsertRowid;
}

function registerFinished(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Parâmetro inválido: entry é obrigatório.');
  }

  const db = getDatabase();
  const id = toNonNegativeInteger(entry.id, 'id');
  const finishedAtMs = toTimestampMs(entry.finishedAtMs, 'finishedAtMs');
  const totalCandidates = toNonNegativeInteger(entry.totalCandidates, 'totalCandidates');
  const processed = toNonNegativeInteger(entry.processed, 'processed');
  const roleAdded = toNonNegativeInteger(entry.roleAdded, 'roleAdded');
  const roleRemoved = toNonNegativeInteger(entry.roleRemoved, 'roleRemoved');
  const alreadyCorrect = toNonNegativeInteger(entry.alreadyCorrect, 'alreadyCorrect');
  const skipped = toNonNegativeInteger(entry.skipped, 'skipped');
  const failed = toNonNegativeInteger(entry.failed, 'failed');
  const status = toNonEmptyString(entry.status, 'status');

  db.prepare(
    `UPDATE subscriber_role_reconciliation_runs
     SET finished_at_ms = ?,
         total_candidates = ?,
         processed = ?,
         role_added = ?,
         role_removed = ?,
         already_correct = ?,
         skipped = ?,
         failed = ?,
         status = ?
     WHERE id = ?`
  ).run(
    finishedAtMs,
    totalCandidates,
    processed,
    roleAdded,
    roleRemoved,
    alreadyCorrect,
    skipped,
    failed,
    status,
    id,
  );
}

function findLatest() {
  const db = getDatabase();
  return (
    db
      .prepare(
        `SELECT id, trigger_type, triggered_by_discord_id, reason, started_at_ms, finished_at_ms,
                total_candidates, processed, role_added, role_removed, already_correct, skipped, failed, status
         FROM subscriber_role_reconciliation_runs
         ORDER BY started_at_ms DESC, id DESC
         LIMIT 1`
      )
      .get() || null
  );
}

function countAll() {
  const db = getDatabase();
  const row = db
    .prepare('SELECT COUNT(1) AS count FROM subscriber_role_reconciliation_runs')
    .get();
  return Number(row?.count || 0);
}

module.exports = {
  registerStarted,
  registerFinished,
  findLatest,
  countAll,
};
