const { getDatabase } = require('./sqliteClient');

function toTimestampMs(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Campo inválido: ${fieldName} deve ser um timestamp em milissegundos.`);
  }
  return Math.trunc(parsed);
}

function toNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Campo inválido: ${fieldName} é obrigatório.`);
  }
  return value.trim();
}

function buildConflictError(message) {
  const error = new Error(message);
  error.code = 'KICK_ACCOUNT_CONFLICT';
  return error;
}

function findByDiscordId(discordId) {
  const db = getDatabase();
  const id = toNonEmptyString(discordId, 'discordId');
  const row = db
    .prepare(
      `SELECT discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms FROM kick_accounts WHERE discord_id = ? LIMIT 1`,
    )
    .get(id);

  return row || null;
}

function findByKickUserId(kickUserId) {
  const db = getDatabase();
  const id = toNonEmptyString(kickUserId, 'kickUserId');
  const row = db
    .prepare(
      `SELECT discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms FROM kick_accounts WHERE kick_user_id = ? LIMIT 1`,
    )
    .get(id);

  return row || null;
}

function upsert(account) {
  if (!account || typeof account !== 'object') {
    throw new Error('Parâmetro inválido: account é obrigatório.');
  }

  const db = getDatabase();
  const discordId = toNonEmptyString(account.discordId, 'discordId');
  const kickUserId = toNonEmptyString(account.kickUserId, 'kickUserId');
  const kickUsername = toNonEmptyString(account.kickUsername, 'kickUsername');
  const updatedAtMs = toTimestampMs(account.updatedAtMs ?? Date.now(), 'updatedAtMs');
  const linkedAtMs = toTimestampMs(account.linkedAtMs ?? updatedAtMs, 'linkedAtMs');

  const selectByDiscordId = db.prepare(
    `SELECT discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms FROM kick_accounts WHERE discord_id = ? LIMIT 1`,
  );
  const selectByKickUserId = db.prepare(
    `SELECT discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms FROM kick_accounts WHERE kick_user_id = ? LIMIT 1`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO kick_accounts (discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)`,
  );
  const updateStmt = db.prepare(
    `UPDATE kick_accounts SET kick_username = ?, updated_at_ms = ? WHERE discord_id = ?`,
  );

  const transaction = db.transaction((payload) => {
    const existingByDiscordId = selectByDiscordId.get(payload.discordId);
    const existingByKickUserId = selectByKickUserId.get(payload.kickUserId);

    if (existingByKickUserId && existingByKickUserId.discord_id !== payload.discordId) {
      throw buildConflictError(
        `Conflito de vínculo: kick_user_id ${payload.kickUserId} já está vinculado a outro discord_id.`,
      );
    }

    if (existingByDiscordId) {
      if (existingByDiscordId.kick_user_id !== payload.kickUserId) {
        throw buildConflictError(
          `Conflito de vínculo: discord_id ${payload.discordId} já está vinculado a outro kick_user_id.`,
        );
      }

      updateStmt.run(payload.kickUsername, payload.updatedAtMs, payload.discordId);
      return selectByDiscordId.get(payload.discordId);
    }

    insertStmt.run(
      payload.discordId,
      payload.kickUserId,
      payload.kickUsername,
      payload.linkedAtMs,
      payload.updatedAtMs,
    );

    return selectByDiscordId.get(payload.discordId);
  });

  return transaction({
    discordId,
    kickUserId,
    kickUsername,
    linkedAtMs,
    updatedAtMs,
  });
}

function deleteByDiscordId(discordId) {
  const db = getDatabase();
  const id = toNonEmptyString(discordId, 'discordId');
  const result = db.prepare(`DELETE FROM kick_accounts WHERE discord_id = ?`).run(id);
  return result.changes > 0;
}

module.exports = {
  findByDiscordId,
  findByKickUserId,
  upsert,
  deleteByDiscordId,
};
