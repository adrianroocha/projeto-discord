const { getDatabase } = require('./sqliteClient');

const ALLOWED_RESULTS = new Set(['pending', 'success', 'failed', 'denied']);

function getDb(txDb) {
  return txDb || getDatabase();
}

function toNullableText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function toSafeInteger(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.trunc(parsed);
}

function toSafeJsonText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function normalizeResult(value) {
  const normalized = toNullableText(value);
  if (!normalized) {
    return 'failed';
  }

  if (!ALLOWED_RESULTS.has(normalized)) {
    throw new Error('Campo inválido: result deve ser pending, success, failed ou denied.');
  }

  return normalized;
}

function mapRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    interactionId: row.interaction_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    actorDiscordId: row.actor_discord_id,
    actorUsername: row.actor_username,
    commandName: row.command_name,
    parametersJson: row.parameters_json,
    queueCycleId: row.queue_cycle_id,
    previousStateJson: row.previous_state_json,
    nextStateJson: row.next_state_json,
    result: row.result,
    errorCode: row.error_code,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    createdAtMs: row.created_at_ms,
  };
}

function findByInteractionId(interactionId, txDb) {
  const db = getDb(txDb);
  const safeInteractionId = toNullableText(interactionId);
  if (!safeInteractionId) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT
        id,
        interaction_id,
        guild_id,
        channel_id,
        actor_discord_id,
        actor_username,
        command_name,
        parameters_json,
        queue_cycle_id,
        previous_state_json,
        next_state_json,
        result,
        error_code,
        started_at_ms,
        finished_at_ms,
        created_at_ms
      FROM admin_command_audit_logs
      WHERE interaction_id = ?
      LIMIT 1`,
    )
    .get(safeInteractionId);

  return mapRow(row);
}

function registerPending(entry, txDb) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Parâmetro inválido: entry é obrigatório.');
  }

  const db = getDb(txDb);
  const interactionId = toNullableText(entry.interactionId);
  const commandName = toNullableText(entry.commandName);

  if (!interactionId) {
    throw new Error('Campo inválido: interactionId é obrigatório.');
  }

  if (!commandName) {
    throw new Error('Campo inválido: commandName é obrigatório.');
  }

  const payload = {
    interactionId,
    guildId: toNullableText(entry.guildId),
    channelId: toNullableText(entry.channelId),
    actorDiscordId: toNullableText(entry.actorDiscordId) || 'unknown',
    actorUsername: toNullableText(entry.actorUsername) || 'unknown',
    commandName,
    parametersJson: toSafeJsonText(entry.parameters),
    queueCycleId: toSafeInteger(entry.queueCycleId, null),
    previousStateJson: toSafeJsonText(entry.previousState),
    nextStateJson: toSafeJsonText(entry.nextState),
    result: 'pending',
    errorCode: null,
    startedAtMs: toSafeInteger(entry.startedAtMs, Date.now()),
    finishedAtMs: null,
    createdAtMs: toSafeInteger(entry.createdAtMs, Date.now()),
  };

  const insertResult = db.prepare(
    `INSERT OR IGNORE INTO admin_command_audit_logs (
      interaction_id,
      guild_id,
      channel_id,
      actor_discord_id,
      actor_username,
      command_name,
      parameters_json,
      queue_cycle_id,
      previous_state_json,
      next_state_json,
      result,
      error_code,
      started_at_ms,
      finished_at_ms,
      created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    payload.interactionId,
    payload.guildId,
    payload.channelId,
    payload.actorDiscordId,
    payload.actorUsername,
    payload.commandName,
    payload.parametersJson,
    payload.queueCycleId,
    payload.previousStateJson,
    payload.nextStateJson,
    payload.result,
    payload.errorCode,
    payload.startedAtMs,
    payload.finishedAtMs,
    payload.createdAtMs,
  );

  const stored = findByInteractionId(payload.interactionId, db);
  if (!stored) {
    throw new Error('Falha ao persistir auditoria administrativa pendente.');
  }

  return {
    ...stored,
    wasCreated: Number(insertResult?.changes || 0) > 0,
  };
}

function finalizeById(id, patch, txDb) {
  if (!patch || typeof patch !== 'object') {
    throw new Error('Parâmetro inválido: patch é obrigatório.');
  }

  const db = getDb(txDb);
  const safeId = toSafeInteger(id, null);
  if (!safeId) {
    throw new Error('Campo inválido: id é obrigatório.');
  }

  const result = normalizeResult(patch.result);
  const finishedAtMs = toSafeInteger(patch.finishedAtMs, Date.now());

  db.prepare(
    `UPDATE admin_command_audit_logs
     SET
      queue_cycle_id = COALESCE(?, queue_cycle_id),
      previous_state_json = COALESCE(?, previous_state_json),
      next_state_json = COALESCE(?, next_state_json),
      result = ?,
      error_code = ?,
      finished_at_ms = ?
     WHERE id = ?`,
  ).run(
    toSafeInteger(patch.queueCycleId, null),
    toSafeJsonText(patch.previousState),
    toSafeJsonText(patch.nextState),
    result,
    toNullableText(patch.errorCode),
    finishedAtMs,
    safeId,
  );

  const row = db
    .prepare(
      `SELECT
        id,
        interaction_id,
        guild_id,
        channel_id,
        actor_discord_id,
        actor_username,
        command_name,
        parameters_json,
        queue_cycle_id,
        previous_state_json,
        next_state_json,
        result,
        error_code,
        started_at_ms,
        finished_at_ms,
        created_at_ms
      FROM admin_command_audit_logs
      WHERE id = ?
      LIMIT 1`,
    )
    .get(safeId);

  return mapRow(row);
}

function countAll(txDb) {
  const db = getDb(txDb);
  const row = db.prepare('SELECT COUNT(1) AS count FROM admin_command_audit_logs').get();
  return Number(row && row.count) || 0;
}

function findLatest(txDb) {
  const db = getDb(txDb);
  const row = db
    .prepare(
      `SELECT
        id,
        interaction_id,
        guild_id,
        channel_id,
        actor_discord_id,
        actor_username,
        command_name,
        parameters_json,
        queue_cycle_id,
        previous_state_json,
        next_state_json,
        result,
        error_code,
        started_at_ms,
        finished_at_ms,
        created_at_ms
      FROM admin_command_audit_logs
      ORDER BY started_at_ms DESC, id DESC
      LIMIT 1`,
    )
    .get();

  return mapRow(row);
}

function deleteOlderThan(cutoffMs, txDb) {
  const db = getDb(txDb);
  const safeCutoffMs = toSafeInteger(cutoffMs, null);
  if (!Number.isSafeInteger(safeCutoffMs) || safeCutoffMs < 0) {
    throw new Error('Campo inválido: cutoffMs deve ser inteiro seguro em milissegundos.');
  }

  const result = db
    .prepare('DELETE FROM admin_command_audit_logs WHERE started_at_ms < ?')
    .run(safeCutoffMs);

  return Number(result && result.changes) || 0;
}

module.exports = {
  registerPending,
  finalizeById,
  findByInteractionId,
  findLatest,
  countAll,
  deleteOlderThan,
};
