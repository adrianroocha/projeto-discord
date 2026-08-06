const crypto = require('crypto');
const config = require('../config');
const kickAccountsRepository = require('../database/kickAccountsRepository');
const kickApiServiceModule = require('./kickApiService');

class KickAuthError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'KickAuthError';
    this.code = code;
    this.httpStatus = options.httpStatus || 400;
    this.category = options.category || 'kick_auth_error';
  }
}

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createKickAuthService(options = {}) {
  const cfg = options.config || config;
  const repository = options.kickAccountsRepository || kickAccountsRepository;
  const kickApiService = options.kickApiService || kickApiServiceModule;
  const logger = options.logger || console;
  const ttlMs = Number(options.ttlMs || 10 * 60 * 1000);
  const now = options.now || (() => Date.now());
  const randomBytes = options.randomBytes || crypto.randomBytes;

  const pendingStates = new Map();
  const usedStates = new Map();

  function isEnabled() {
    return Boolean(cfg.kickEnabled && cfg.kickClientId && cfg.kickClientSecret && cfg.kickRedirectUri);
  }

  function cleanupUsedStates() {
    const timestamp = now();

    for (const [state, expiresAtMs] of usedStates.entries()) {
      if (expiresAtMs <= timestamp) {
        usedStates.delete(state);
      }
    }
  }

  function cleanupExpiredStates() {
    const timestamp = now();

    for (const [state, attempt] of pendingStates.entries()) {
      if (attempt.expiresAtMs <= timestamp) {
        pendingStates.delete(state);
      }
    }

    cleanupUsedStates();
  }

  function generateState() {
    return base64UrlEncode(randomBytes(32));
  }

  function generateCodeVerifier() {
    return base64UrlEncode(randomBytes(48));
  }

  function generateCodeChallenge(codeVerifier) {
    return base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  }

  function buildAuthorizationUrl(payload) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: payload.clientId,
      redirect_uri: payload.redirectUri,
      scope: payload.scope,
      code_challenge: payload.codeChallenge,
      code_challenge_method: 'S256',
      state: payload.state,
    });

    return `https://id.kick.com/oauth/authorize?${params.toString()}`;
  }

  function createAuthorizationAttempt(discordId) {
    cleanupExpiredStates();

    if (!isEnabled()) {
      throw new KickAuthError('KICK_OAUTH_DISABLED', 'Integração Kick desativada.', {
        httpStatus: 503,
        category: 'kick_oauth_disabled',
      });
    }

    if (typeof discordId !== 'string' || !discordId.trim()) {
      throw new KickAuthError('INVALID_DISCORD_ID', 'Discord ID inválido.', {
        httpStatus: 400,
        category: 'invalid_discord_id',
      });
    }

    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const createdAtMs = now();
    const expiresAtMs = createdAtMs + ttlMs;

    pendingStates.set(state, {
      discordId: discordId.trim(),
      codeVerifier,
      createdAtMs,
      expiresAtMs,
    });

    return {
      state,
      expiresAtMs,
      ttlMs,
      authorizationUrl: buildAuthorizationUrl({
        clientId: cfg.kickClientId,
        redirectUri: cfg.kickRedirectUri,
        scope: 'user:read',
        codeChallenge,
        state,
      }),
    };
  }

  function consumeValidState(state) {
    cleanupUsedStates();

    if (!state || typeof state !== 'string') {
      throw new KickAuthError('STATE_INVALID', 'State inválido.', {
        httpStatus: 400,
        category: 'state_invalid',
      });
    }

    if (usedStates.has(state)) {
      throw new KickAuthError('STATE_REUSED', 'State já utilizado.', {
        httpStatus: 400,
        category: 'state_reused',
      });
    }

    const attempt = pendingStates.get(state);
    if (!attempt) {
      throw new KickAuthError('STATE_INVALID', 'State inválido.', {
        httpStatus: 400,
        category: 'state_invalid',
      });
    }

    if (attempt.expiresAtMs <= now()) {
      pendingStates.delete(state);
      throw new KickAuthError('STATE_EXPIRED', 'State expirado.', {
        httpStatus: 400,
        category: 'state_expired',
      });
    }

    pendingStates.delete(state);
    usedStates.set(state, now() + ttlMs);
    return attempt;
  }

  async function completeOAuthCallback(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new KickAuthError('CALLBACK_INVALID', 'Parâmetros inválidos no callback.', {
        httpStatus: 400,
        category: 'callback_invalid',
      });
    }

    if (!payload.code) {
      throw new KickAuthError('MISSING_CODE', 'Parâmetro code ausente.', {
        httpStatus: 400,
        category: 'missing_code',
      });
    }

    if (!payload.state) {
      throw new KickAuthError('MISSING_STATE', 'Parâmetro state ausente.', {
        httpStatus: 400,
        category: 'missing_state',
      });
    }

    if (!isEnabled()) {
      throw new KickAuthError('KICK_OAUTH_DISABLED', 'Integração Kick desativada.', {
        httpStatus: 503,
        category: 'kick_oauth_disabled',
      });
    }

    const attempt = consumeValidState(payload.state);

    const tokenResponse = await kickApiService.exchangeAuthorizationCode({
      clientId: cfg.kickClientId,
      clientSecret: cfg.kickClientSecret,
      redirectUri: cfg.kickRedirectUri,
      codeVerifier: attempt.codeVerifier,
      code: payload.code,
    });

    const user = await kickApiService.getAuthorizedUser(tokenResponse.accessToken);

    const saved = repository.upsert({
      discordId: attempt.discordId,
      kickUserId: user.kickUserId,
      kickUsername: user.kickUsername,
      updatedAtMs: now(),
    });

    return {
      discordId: saved.discord_id,
      kickUserId: saved.kick_user_id,
      kickUsername: saved.kick_username,
    };
  }

  function safeLog(category, details) {
    if (typeof logger?.warn === 'function') {
      logger.warn(`Kick OAuth: ${category}`, details || '');
    }
  }

  return {
    isEnabled,
    cleanupExpiredStates,
    generateState,
    generateCodeVerifier,
    generateCodeChallenge,
    buildAuthorizationUrl,
    createAuthorizationAttempt,
    consumeValidState,
    completeOAuthCallback,
    safeLog,
    KickAuthError,
  };
}

const defaultService = createKickAuthService();
defaultService.createKickAuthService = createKickAuthService;
defaultService.KickAuthError = KickAuthError;

module.exports = defaultService;
