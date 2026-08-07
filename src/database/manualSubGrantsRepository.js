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

function buildConflictError(message) {
  const error = new Error(message);
  error.code = 'MANUAL_SUB_GRANT_ACTIVE_EXISTS';
  return error;
}

function findActiveByDiscordId(discordId, nowMs) {
  const db = getDatabase();
  const id = toNonEmptyString(discordId, 'discordId');
  const referenceNow = toTimestampMs(nowMs, 'nowMs');

  const row = db
    .prepare(
      `SELECT id, discord_id, granted_by_discord_id, reason, granted_at_ms, expires_at_ms, revoked_at_ms, revoked_by_discord_id, revoke_reason
       FROM manual_sub_grants
       WHERE discord_id = ?
         AND revoked_at_ms IS NULL
         AND (expires_at_ms IS NULL OR expires_at_ms > ?)
       ORDER BY granted_at_ms DESC, id DESC
       LIMIT 1`,
    )
    .get(id, referenceNow);

  return row || null;
}

function findHistoryByDiscordId(discordId) {
  const db = getDatabase();
  const id = toNonEmptyString(discordId, 'discordId');

  return db
    .prepare(
      `SELECT id, discord_id, granted_by_discord_id, reason, granted_at_ms, expires_at_ms, revoked_at_ms, revoked_by_discord_id, revoke_reason
       FROM manual_sub_grants
       WHERE discord_id = ?
       ORDER BY granted_at_ms DESC, id DESC`,
    )
    .all(id);
}

function listDistinctDiscordIds() {
  const db = getDatabase();

  return db
    .prepare(
      `SELECT DISTINCT discord_id
       FROM manual_sub_grants
       WHERE discord_id IS NOT NULL AND TRIM(discord_id) <> ''
       ORDER BY discord_id ASC`,
    )
    .all()
    .map((row) => row.discord_id);
}

function createGrant(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Parâmetro inválido: data é obrigatório.');
  }

  const db = getDatabase();
  const discordId = toNonEmptyString(data.discordId, 'discordId');
  const grantedByDiscordId = toNonEmptyString(data.grantedByDiscordId, 'grantedByDiscordId');
  const reason = toNonEmptyString(data.reason, 'reason');
  const grantedAtMs = toTimestampMs(data.grantedAtMs, 'grantedAtMs');
  const expiresAtMs =
    data.expiresAtMs === null || data.expiresAtMs === undefined
      ? null
      : toTimestampMs(data.expiresAtMs, 'expiresAtMs');

  const findActiveStmt = db.prepare(
    `SELECT id
     FROM manual_sub_grants
     WHERE discord_id = ?
       AND revoked_at_ms IS NULL
       AND (expires_at_ms IS NULL OR expires_at_ms > ?)
     ORDER BY granted_at_ms DESC, id DESC
     LIMIT 1`,
  );

  const insertStmt = db.prepare(
    `INSERT INTO manual_sub_grants (
      discord_id,
      granted_by_discord_id,
      reason,
      granted_at_ms,
      expires_at_ms,
      revoked_at_ms,
      revoked_by_discord_id,
      revoke_reason
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  );

  const selectByIdStmt = db.prepare(
    `SELECT id, discord_id, granted_by_discord_id, reason, granted_at_ms, expires_at_ms, revoked_at_ms, revoked_by_discord_id, revoke_reason
     FROM manual_sub_grants
     WHERE id = ?
     LIMIT 1`,
  );

  const transaction = db.transaction((payload) => {
    const active = findActiveStmt.get(payload.discordId, payload.grantedAtMs);
    if (active) {
      throw buildConflictError(
        `Concessão manual ativa já existe para discord_id ${payload.discordId}.`,
      );
    }

    const result = insertStmt.run(
      payload.discordId,
      payload.grantedByDiscordId,
      payload.reason,
      payload.grantedAtMs,
      payload.expiresAtMs,
    );

    return selectByIdStmt.get(result.lastInsertRowid);
  });

  return transaction({
    discordId,
    grantedByDiscordId,
    reason,
    grantedAtMs,
    expiresAtMs,
  });
}

function revokeActiveByDiscordId(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Parâmetro inválido: data é obrigatório.');
  }

  const db = getDatabase();
  const discordId = toNonEmptyString(data.discordId, 'discordId');
  const revokedByDiscordId = toNonEmptyString(data.revokedByDiscordId, 'revokedByDiscordId');
  const revokeReason = toNonEmptyString(data.revokeReason, 'revokeReason');
  const revokedAtMs = toTimestampMs(data.revokedAtMs, 'revokedAtMs');

  const findActiveStmt = db.prepare(
    `SELECT id
     FROM manual_sub_grants
     WHERE discord_id = ?
       AND revoked_at_ms IS NULL
       AND (expires_at_ms IS NULL OR expires_at_ms > ?)
     ORDER BY granted_at_ms DESC, id DESC
     LIMIT 1`,
  );

  const updateStmt = db.prepare(
    `UPDATE manual_sub_grants
     SET revoked_at_ms = ?, revoked_by_discord_id = ?, revoke_reason = ?
     WHERE id = ?`,
  );

  const selectByIdStmt = db.prepare(
    `SELECT id, discord_id, granted_by_discord_id, reason, granted_at_ms, expires_at_ms, revoked_at_ms, revoked_by_discord_id, revoke_reason
     FROM manual_sub_grants
     WHERE id = ?
     LIMIT 1`,
  );

  const transaction = db.transaction((payload) => {
    const active = findActiveStmt.get(payload.discordId, payload.revokedAtMs);
    if (!active) {
      return {
        revoked: false,
        reason: 'not_found',
      };
    }

    updateStmt.run(payload.revokedAtMs, payload.revokedByDiscordId, payload.revokeReason, active.id);
    const grant = selectByIdStmt.get(active.id);
    return {
      revoked: true,
      grant,
    };
  });

  return transaction({
    discordId,
    revokedByDiscordId,
    revokeReason,
    revokedAtMs,
  });
}

function hasActiveGrant(discordId, nowMs) {
  return Boolean(findActiveByDiscordId(discordId, nowMs));
}

module.exports = {
  createGrant,
  findActiveByDiscordId,
  findHistoryByDiscordId,
  listDistinctDiscordIds,
  revokeActiveByDiscordId,
  hasActiveGrant,
};
