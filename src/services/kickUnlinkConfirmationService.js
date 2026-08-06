const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const confirmations = new Map();

function now() {
  return Date.now();
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function create(discordId, metadata = {}) {
  if (typeof discordId !== 'string' || !discordId.trim()) {
    throw new Error('discordId inválido para confirmação de desvinculação.');
  }

  const token = generateToken();
  confirmations.set(token, {
    token,
    discordId: discordId.trim(),
    createdAtMs: now(),
    expiresAtMs: now() + TTL_MS,
    consumed: false,
    metadata,
  });

  return {
    token,
    expiresAtMs: confirmations.get(token).expiresAtMs,
  };
}

function consume(token, discordId) {
  const entry = confirmations.get(token);
  if (!entry) {
    return { ok: false, reason: 'not_found' };
  }

  if (entry.consumed) {
    confirmations.delete(token);
    return { ok: false, reason: 'already_used' };
  }

  if (entry.expiresAtMs <= now()) {
    confirmations.delete(token);
    return { ok: false, reason: 'expired' };
  }

  if (entry.discordId !== discordId) {
    return { ok: false, reason: 'forbidden' };
  }

  entry.consumed = true;
  confirmations.delete(token);
  return {
    ok: true,
    token: entry.token,
    discordId: entry.discordId,
    metadata: entry.metadata,
  };
}

function validate(token, discordId) {
  const entry = confirmations.get(token);
  if (!entry) {
    return { ok: false, reason: 'not_found' };
  }

  if (entry.consumed) {
    confirmations.delete(token);
    return { ok: false, reason: 'already_used' };
  }

  if (entry.expiresAtMs <= now()) {
    confirmations.delete(token);
    return { ok: false, reason: 'expired' };
  }

  if (entry.discordId !== discordId) {
    return { ok: false, reason: 'forbidden' };
  }

  return {
    ok: true,
    token: entry.token,
    discordId: entry.discordId,
    metadata: entry.metadata,
    expiresAtMs: entry.expiresAtMs,
  };
}

function invalidate(token) {
  return confirmations.delete(token);
}

function cleanupExpired() {
  const current = now();
  for (const [token, entry] of confirmations.entries()) {
    if (entry.expiresAtMs <= current || entry.consumed) {
      confirmations.delete(token);
    }
  }
}

function getTtlMs() {
  return TTL_MS;
}

function _resetForTests() {
  confirmations.clear();
}

module.exports = {
  create,
  consume,
  validate,
  invalidate,
  cleanupExpired,
  getTtlMs,
  _resetForTests,
};
