const { getDatabase } = require('./sqliteClient');
const livepixUnlinkAuditRepository = require('./livepixUnlinkAuditRepository');

function toNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Campo inválido: ${fieldName} é obrigatório.`);
  }
  return value.trim();
}

function toTimestampMs(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Campo inválido: ${fieldName} deve ser um timestamp válido.`);
  }
  return parsed;
}

function createConflictError(reason) {
  const error = new Error('Este usuário do Discord ou esta conta LivePix já possui um vínculo.');
  error.code = 'LIVEPIX_ACCOUNT_CONFLICT';
  error.reason = reason;
  return error;
}

function findByDiscordId(discordId) {
  const id = toNonEmptyString(discordId, 'discordId');
  return (
    getDatabase()
      .prepare(
        `SELECT discord_id, livepix_account_id, created_at_ms, updated_at_ms
         FROM livepix_accounts WHERE discord_id = ? LIMIT 1`,
      )
      .get(id) || null
  );
}

function createLink(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Parâmetro inválido: input é obrigatório.');
  }

  const discordId = toNonEmptyString(input.discordId, 'discordId');
  const livepixAccountId = toNonEmptyString(input.livepixAccountId, 'livepixAccountId');
  const createdAtMs = toTimestampMs(input.createdAtMs ?? Date.now(), 'createdAtMs');
  const updatedAtMs = toTimestampMs(input.updatedAtMs ?? createdAtMs, 'updatedAtMs');
  const db = getDatabase();

  const transaction = db.transaction(() => {
    const existingByDiscord = db
      .prepare('SELECT 1 FROM livepix_accounts WHERE discord_id = ? LIMIT 1')
      .get(discordId);
    if (existingByDiscord) {
      throw createConflictError('discord_already_linked');
    }

    const existingByAccount = db
      .prepare('SELECT 1 FROM livepix_accounts WHERE livepix_account_id = ? LIMIT 1')
      .get(livepixAccountId);
    if (existingByAccount) {
      throw createConflictError('account_already_linked');
    }

    db.prepare(
      `INSERT INTO livepix_accounts (discord_id, livepix_account_id, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?)`,
    ).run(discordId, livepixAccountId, createdAtMs, updatedAtMs);

    return findByDiscordId(discordId);
  });

  try {
    return transaction();
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw createConflictError('concurrent_conflict');
    }
    throw error;
  }
}

function unlinkWithAudit(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Parâmetro inválido: input é obrigatório.');
  }

  const db = getDatabase();
  const discordId = toNonEmptyString(input.discordId, 'discordId');
  const unlinkedByDiscordId = toNonEmptyString(input.unlinkedByDiscordId, 'unlinkedByDiscordId');
  const reason = toNonEmptyString(input.reason, 'reason');
  const unlinkedAtMs = toTimestampMs(input.unlinkedAtMs ?? Date.now(), 'unlinkedAtMs');

  const transaction = db.transaction(() => {
    const existing = findByDiscordId(discordId);
    if (!existing) {
      return { unlinked: false, reason: 'not_found' };
    }

    if (!db.prepare('DELETE FROM livepix_accounts WHERE discord_id = ?').run(discordId).changes) {
      throw new Error('Não foi possível remover vínculo LivePix para auditoria.');
    }

    const audit = livepixUnlinkAuditRepository.register(
      {
        discordId,
        livepixAccountId: existing.livepix_account_id,
        unlinkedByDiscordId,
        unlinkedAtMs,
        reason,
      },
      db,
    );

    return { unlinked: true, account: existing, audit };
  });

  return transaction();
}

module.exports = {
  findByDiscordId,
  createLink,
  unlinkWithAudit,
};
