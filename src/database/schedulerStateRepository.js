const { getDatabase } = require('./sqliteClient');

function getDb(fromDb) {
  return fromDb || getDatabase();
}

function toNullableText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function toNullableInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Valor numérico inválido para scheduler_state.');
  }
  return Math.trunc(parsed);
}

function ensureRow(txDb) {
  const db = getDb(txDb);
  const row = db.prepare('SELECT id FROM scheduler_state WHERE id = 1').get();

  if (!row) {
    db.prepare(
      `INSERT INTO scheduler_state (
        id,
        current_state,
        state_origin,
        manual_override_state,
        manual_override_until_ms,
        last_scheduled_open_cycle_key,
        last_scheduled_open_at_ms,
        last_scheduled_close_at_ms,
        updated_at_ms
      ) VALUES (1, 'closed', 'scheduled', NULL, NULL, NULL, NULL, NULL, ?)`
    ).run(Date.now());
  }
}

function mapRow(row) {
  return {
    currentState: row.current_state,
    stateOrigin: row.state_origin,
    manualOverrideState: row.manual_override_state,
    manualOverrideUntilMs: row.manual_override_until_ms,
    lastScheduledOpenCycleKey: row.last_scheduled_open_cycle_key,
    lastScheduledOpenAtMs: row.last_scheduled_open_at_ms,
    lastScheduledCloseAtMs: row.last_scheduled_close_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function getState(txDb) {
  const db = getDb(txDb);
  ensureRow(db);

  const row = db.prepare(
    `SELECT
      current_state,
      state_origin,
      manual_override_state,
      manual_override_until_ms,
      last_scheduled_open_cycle_key,
      last_scheduled_open_at_ms,
      last_scheduled_close_at_ms,
      updated_at_ms
     FROM scheduler_state
     WHERE id = 1`
  ).get();

  return mapRow(row);
}

function updateState(patch, txDb) {
  if (!patch || typeof patch !== 'object') {
    throw new Error('Parâmetro inválido: patch é obrigatório.');
  }

  const db = getDb(txDb);
  ensureRow(db);

  const current = getState(db);
  const next = {
    current_state:
      toNullableText(patch.currentState) ||
      toNullableText(current.currentState) ||
      'closed',
    state_origin:
      toNullableText(patch.stateOrigin) ||
      toNullableText(current.stateOrigin) ||
      'scheduled',
    manual_override_state:
      Object.prototype.hasOwnProperty.call(patch, 'manualOverrideState')
        ? toNullableText(patch.manualOverrideState)
        : current.manualOverrideState,
    manual_override_until_ms:
      Object.prototype.hasOwnProperty.call(patch, 'manualOverrideUntilMs')
        ? toNullableInteger(patch.manualOverrideUntilMs)
        : current.manualOverrideUntilMs,
    last_scheduled_open_cycle_key:
      Object.prototype.hasOwnProperty.call(patch, 'lastScheduledOpenCycleKey')
        ? toNullableText(patch.lastScheduledOpenCycleKey)
        : current.lastScheduledOpenCycleKey,
    last_scheduled_open_at_ms:
      Object.prototype.hasOwnProperty.call(patch, 'lastScheduledOpenAtMs')
        ? toNullableInteger(patch.lastScheduledOpenAtMs)
        : current.lastScheduledOpenAtMs,
    last_scheduled_close_at_ms:
      Object.prototype.hasOwnProperty.call(patch, 'lastScheduledCloseAtMs')
        ? toNullableInteger(patch.lastScheduledCloseAtMs)
        : current.lastScheduledCloseAtMs,
    updated_at_ms: toNullableInteger(patch.updatedAtMs) || Date.now(),
  };

  db.prepare(
    `UPDATE scheduler_state
     SET current_state = ?,
         state_origin = ?,
         manual_override_state = ?,
         manual_override_until_ms = ?,
         last_scheduled_open_cycle_key = ?,
         last_scheduled_open_at_ms = ?,
         last_scheduled_close_at_ms = ?,
         updated_at_ms = ?
     WHERE id = 1`
  ).run(
    next.current_state,
    next.state_origin,
    next.manual_override_state,
    next.manual_override_until_ms,
    next.last_scheduled_open_cycle_key,
    next.last_scheduled_open_at_ms,
    next.last_scheduled_close_at_ms,
    next.updated_at_ms,
  );

  return getState(db);
}

module.exports = {
  getState,
  updateState,
};
