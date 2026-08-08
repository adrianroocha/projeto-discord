const { getDatabase } = require('./sqliteClient');

function getDb(fromDb) {
  return fromDb || getDatabase();
}

function ensureRow(txDb) {
  const db = getDb(txDb);
  const row = db.prepare('SELECT id FROM app_sqlite_backup_scheduler_state WHERE id = 1').get();
  if (!row) {
    db.prepare(
      `INSERT INTO app_sqlite_backup_scheduler_state (
        id,
        last_success_local_date,
        last_attempt_started_at_ms,
        last_result,
        updated_at_ms
      ) VALUES (1, NULL, NULL, NULL, ?)`
    ).run(Date.now());
  }
}

function getState(txDb) {
  const db = getDb(txDb);
  ensureRow(db);
  return db
    .prepare(
      `SELECT
        last_success_local_date,
        last_attempt_started_at_ms,
        last_result,
        updated_at_ms
      FROM app_sqlite_backup_scheduler_state
      WHERE id = 1`
    )
    .get();
}

function updateState(patch, txDb) {
  const db = getDb(txDb);
  ensureRow(db);

  const current = getState(db);
  const next = {
    lastSuccessLocalDate:
      Object.prototype.hasOwnProperty.call(patch || {}, 'lastSuccessLocalDate')
        ? patch.lastSuccessLocalDate || null
        : current.last_success_local_date,
    lastAttemptStartedAtMs:
      Object.prototype.hasOwnProperty.call(patch || {}, 'lastAttemptStartedAtMs')
        ? Number.isFinite(Number(patch.lastAttemptStartedAtMs))
          ? Math.trunc(Number(patch.lastAttemptStartedAtMs))
          : null
        : current.last_attempt_started_at_ms,
    lastResult:
      Object.prototype.hasOwnProperty.call(patch || {}, 'lastResult')
        ? patch.lastResult || null
        : current.last_result,
    updatedAtMs: Date.now(),
  };

  db.prepare(
    `UPDATE app_sqlite_backup_scheduler_state
     SET last_success_local_date = ?,
         last_attempt_started_at_ms = ?,
         last_result = ?,
         updated_at_ms = ?
     WHERE id = 1`
  ).run(
    next.lastSuccessLocalDate,
    next.lastAttemptStartedAtMs,
    next.lastResult,
    next.updatedAtMs,
  );

  return getState(db);
}

module.exports = {
  getState,
  updateState,
};
