const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const confirmations = new Map();

function create(discordId) {
  if (typeof discordId !== 'string' || !discordId.trim()) {
    throw new Error('discordId inválido para confirmação de desvinculação LivePix.');
  }
  const token = crypto.randomBytes(16).toString('hex');
  confirmations.set(token, { discordId: discordId.trim(), expiresAtMs: Date.now() + TTL_MS });
  return { token, expiresAtMs: Date.now() + TTL_MS };
}

function consume(token, discordId) {
  const entry = confirmations.get(token);
  if (!entry || entry.expiresAtMs <= Date.now()) {
    confirmations.delete(token);
    return { ok: false, reason: 'invalid' };
  }
  if (entry.discordId !== discordId) {
    return { ok: false, reason: 'forbidden' };
  }
  confirmations.delete(token);
  return { ok: true };
}

function invalidate(token, discordId) {
  const entry = confirmations.get(token);
  if (!entry || entry.discordId !== discordId) {
    return false;
  }
  return confirmations.delete(token);
}

function _resetForTests() {
  confirmations.clear();
}

module.exports = { create, consume, invalidate, _resetForTests, TTL_MS };
