const { getDatabase } = require('./sqliteClient');

function getDb(fromDb) {
  return fromDb || getDatabase();
}

function ensureSafeText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function ensureSafeInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.trunc(parsed);
}

function saveRun(entry, txDb) {
  const db = getDb(txDb);
  const payload = entry || {};

  db.prepare(
    `INSERT INTO app_sqlite_backup_runs (
      trigger_type,
      started_at_ms,
      finished_at_ms,
      file_name,
      size_bytes,
      integrity_result,
      result,
      error_code,
      created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ensureSafeText(payload.triggerType) || 'unknown',
    ensureSafeInteger(payload.startedAtMs) || Date.now(),
    ensureSafeInteger(payload.finishedAtMs) || Date.now(),
    ensureSafeText(payload.fileName),
    ensureSafeInteger(payload.sizeBytes),
    ensureSafeText(payload.integrityResult) || 'unknown',
    ensureSafeText(payload.result) || 'failed',
    ensureSafeText(payload.errorCode),
    Date.now(),
  );
}

function listRecent(limit = 20, txDb) {
  const db = getDb(txDb);
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 20)));

  return db
    .prepare(
      `SELECT
        id,
        trigger_type,
        started_at_ms,
        finished_at_ms,
        file_name,
        size_bytes,
        integrity_result,
        result,
        error_code,
        created_at_ms
      FROM app_sqlite_backup_runs
      ORDER BY created_at_ms DESC
      LIMIT ?`
    )
    .all(safeLimit);
}

module.exports = {
  saveRun,
  listRecent,
};
