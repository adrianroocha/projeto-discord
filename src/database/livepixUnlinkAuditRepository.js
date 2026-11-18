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
  const livepixAccountId = toNonEmptyString(entry.livepixAccountId, 'livepixAccountId');
  const unlinkedByDiscordId = toNonEmptyString(entry.unlinkedByDiscordId, 'unlinkedByDiscordId');
  const unlinkedAtMs = toTimestampMs(entry.unlinkedAtMs, 'unlinkedAtMs');
  const reason = toNonEmptyString(entry.reason, 'reason');
  const result = db
    .prepare(
      `INSERT INTO livepix_unlink_audit (
        discord_id,
        livepix_account_id,
        unlinked_by_discord_id,
        unlinked_at_ms,
        reason
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(discordId, livepixAccountId, unlinkedByDiscordId, unlinkedAtMs, reason);

  return db
    .prepare(
      `SELECT id, discord_id, livepix_account_id, unlinked_by_discord_id, unlinked_at_ms, reason
       FROM livepix_unlink_audit
       WHERE id = ?
       LIMIT 1`,
    )
    .get(result.lastInsertRowid);
}

function countAll() {
  return getDatabase().prepare('SELECT COUNT(1) AS count FROM livepix_unlink_audit').get().count;
}

function findLatest() {
  return (
    getDatabase()
      .prepare(
        `SELECT id, discord_id, livepix_account_id, unlinked_by_discord_id, unlinked_at_ms, reason
         FROM livepix_unlink_audit
         ORDER BY unlinked_at_ms DESC, id DESC
         LIMIT 1`,
      )
      .get() || null
  );
}

module.exports = { register, countAll, findLatest };
