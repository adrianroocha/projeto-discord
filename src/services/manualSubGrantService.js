const manualSubGrantsRepository = require('../database/manualSubGrantsRepository');

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const MAX_REASON_LENGTH = 280;
const DAY_MS = 24 * 60 * 60 * 1000;

function getNowMs(nowMs) {
  if (nowMs === undefined || nowMs === null) {
    return Date.now();
  }

  const parsed = Number(nowMs);
  if (!Number.isFinite(parsed)) {
    throw new Error('nowMs inválido.');
  }

  return Math.trunc(parsed);
}

function normalizeDiscordId(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Campo inválido: ${fieldName} é obrigatório.`);
  }

  return value.trim();
}

function normalizeReason(value) {
  if (typeof value !== 'string') {
    throw new Error('Campo inválido: motivo é obrigatório.');
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Campo inválido: motivo é obrigatório.');
  }

  if (normalized.length > MAX_REASON_LENGTH) {
    throw new Error(`Campo inválido: motivo deve ter no máximo ${MAX_REASON_LENGTH} caracteres.`);
  }

  return normalized;
}

function normalizeDurationDays(days) {
  if (days === undefined || days === null) {
    return null;
  }

  const parsed = Number(days);
  if (!Number.isInteger(parsed)) {
    throw new Error('Campo inválido: dias deve ser um inteiro entre 1 e 365.');
  }

  if (parsed < MIN_DAYS || parsed > MAX_DAYS) {
    throw new Error('Campo inválido: dias deve estar entre 1 e 365.');
  }

  return parsed;
}

function toGrantResult(grant) {
  return {
    id: grant.id,
    discordId: grant.discord_id,
    grantedByDiscordId: grant.granted_by_discord_id,
    reason: grant.reason,
    grantedAtMs: grant.granted_at_ms,
    expiresAtMs: grant.expires_at_ms,
    revokedAtMs: grant.revoked_at_ms,
    revokedByDiscordId: grant.revoked_by_discord_id,
    revokeReason: grant.revoke_reason,
  };
}

function calculateExpiresAtMs(grantedAtMs, days) {
  if (days === null) {
    return null;
  }

  return grantedAtMs + days * DAY_MS;
}

function createGrant(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Parâmetro inválido: input é obrigatório.');
  }

  const nowMs = getNowMs(input.nowMs);
  const discordId = normalizeDiscordId(input.discordId, 'discordId');
  const grantedByDiscordId = normalizeDiscordId(input.grantedByDiscordId, 'grantedByDiscordId');
  const reason = normalizeReason(input.reason);
  const days = normalizeDurationDays(input.days);
  const expiresAtMs = calculateExpiresAtMs(nowMs, days);

  try {
    const created = manualSubGrantsRepository.createGrant({
      discordId,
      grantedByDiscordId,
      reason,
      grantedAtMs: nowMs,
      expiresAtMs,
    });

    return {
      created: true,
      grant: toGrantResult(created),
      isPermanent: expiresAtMs === null,
      days,
    };
  } catch (error) {
    if (error && error.code === 'MANUAL_SUB_GRANT_ACTIVE_EXISTS') {
      return {
        created: false,
        reason: 'active_exists',
      };
    }

    throw error;
  }
}

function revokeGrant(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Parâmetro inválido: input é obrigatório.');
  }

  const nowMs = getNowMs(input.nowMs);
  const discordId = normalizeDiscordId(input.discordId, 'discordId');
  const revokedByDiscordId = normalizeDiscordId(input.revokedByDiscordId, 'revokedByDiscordId');
  const revokeReason = normalizeReason(input.reason);

  const result = manualSubGrantsRepository.revokeActiveByDiscordId({
    discordId,
    revokedByDiscordId,
    revokeReason,
    revokedAtMs: nowMs,
  });

  if (!result.revoked) {
    return {
      revoked: false,
      reason: 'not_found',
    };
  }

  return {
    revoked: true,
    grant: toGrantResult(result.grant),
  };
}

function getStatus(discordId, nowMs) {
  const targetDiscordId = normalizeDiscordId(discordId, 'discordId');
  const referenceNow = getNowMs(nowMs);

  const activeGrant = manualSubGrantsRepository.findActiveByDiscordId(targetDiscordId, referenceNow);
  const history = manualSubGrantsRepository.findHistoryByDiscordId(targetDiscordId);

  const latestGrant = history[0] || null;
  const latestRevocation = history.find((item) => item.revoked_at_ms !== null) || null;

  return {
    active: activeGrant ? toGrantResult(activeGrant) : null,
    latestGrant: latestGrant ? toGrantResult(latestGrant) : null,
    latestRevocation: latestRevocation ? toGrantResult(latestRevocation) : null,
    history: history.map(toGrantResult),
  };
}

function getHistory(discordId) {
  const targetDiscordId = normalizeDiscordId(discordId, 'discordId');
  const history = manualSubGrantsRepository.findHistoryByDiscordId(targetDiscordId);
  return history.map(toGrantResult);
}

function hasActiveGrant(discordId, nowMs) {
  const targetDiscordId = normalizeDiscordId(discordId, 'discordId');
  const referenceNow = getNowMs(nowMs);
  return manualSubGrantsRepository.hasActiveGrant(targetDiscordId, referenceNow);
}

module.exports = {
  createGrant,
  revokeGrant,
  getStatus,
  getHistory,
  hasActiveGrant,
  constants: {
    MIN_DAYS,
    MAX_DAYS,
    MAX_REASON_LENGTH,
    DAY_MS,
  },
};
