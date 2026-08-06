const { getDatabase } = require('./sqliteClient');

function getDb(txDb) {
  return txDb || getDatabase();
}

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

function register(entry, txDb) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Parâmetro inválido: entry é obrigatório.');
  }

  const db = getDb(txDb);
  const discordId = toNonEmptyString(entry.discordId, 'discordId');
  const kickUserId = toNonEmptyString(entry.kickUserId, 'kickUserId');
  const kickUsername = toNonEmptyString(entry.kickUsername, 'kickUsername');
  const unlinkedByDiscordId = toNonEmptyString(entry.unlinkedByDiscordId, 'unlinkedByDiscordId');
  const unlinkedAtMs = toTimestampMs(entry.unlinkedAtMs, 'unlinkedAtMs');
  const reason = toNonEmptyString(entry.reason, 'reason');

  const result = db.prepare(
    `INSERT INTO kick_unlink_audit (
      discord_id,
      kick_user_id,
      kick_username,
      unlinked_by_discord_id,
      unlinked_at_ms,
      reason
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    discordId,
    kickUserId,
    kickUsername,
    unlinkedByDiscordId,
    unlinkedAtMs,
    reason,
  );

  return db.prepare(
    `SELECT id, discord_id, kick_user_id, kick_username, unlinked_by_discord_id, unlinked_at_ms, reason
     FROM kick_unlink_audit
     WHERE id = ?
     LIMIT 1`,
  ).get(result.lastInsertRowid);
}

function countAll() {
  const db = getDatabase();
  return db.prepare('SELECT COUNT(1) AS count FROM kick_unlink_audit').get().count;
}

function findLatest() {
  const db = getDatabase();
  return db.prepare(
    `SELECT id, discord_id, kick_user_id, kick_username, unlinked_by_discord_id, unlinked_at_ms, reason
     FROM kick_unlink_audit
     ORDER BY unlinked_at_ms DESC, id DESC
     LIMIT 1`,
  ).get() || null;
}

module.exports = {
  register,
  countAll,
  findLatest,
};
