const crypto = require('crypto');
const config = require('../config');
const livepixApiServiceModule = require('./livepixApiService');
const livepixAccountsRepository = require('../database/livepixAccountsRepository');

const STATE_TTL_MS = 10 * 60 * 1000;

class LivePixLinkAuthError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'LivePixLinkAuthError';
    this.code = code;
    this.httpStatus = options.httpStatus || 400;
    this.category = options.category || 'livepix_link_auth_error';
  }
}

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createLivePixLinkAuthService(options = {}) {
  const cfg = options.config || config;
  const apiService =
    options.livepixApiService ||
    livepixApiServiceModule.createLivePixApiService({
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      oauthBaseUrl: options.oauthBaseUrl,
      apiBaseUrl: options.apiBaseUrl,
    });
  const repository = options.livepixAccountsRepository || livepixAccountsRepository;
  const now = options.now || (() => Date.now());
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const pendingStates = new Map();
  const usedStates = new Map();
  const expiredStates = new Map();

  function isEnabled() {
    return Boolean(
      cfg.livepixClientId &&
        cfg.livepixClientSecret &&
        cfg.livepixRedirectUri &&
        cfg.livepixLinkEnabled !== false,
    );
  }

  function createError(code, message, httpStatus = 400) {
    return new LivePixLinkAuthError(code, message, { httpStatus, category: code.toLowerCase() });
  }

  function cleanupStates() {
    const currentTime = now();
    for (const [state, attempt] of pendingStates.entries()) {
      if (attempt.expiresAtMs <= currentTime) {
        pendingStates.delete(state);
        expiredStates.set(state, currentTime + STATE_TTL_MS);
      }
    }
    for (const [state, expiresAtMs] of usedStates.entries()) {
      if (expiresAtMs <= currentTime) {
        usedStates.delete(state);
      }
    }
    for (const [state, expiresAtMs] of expiredStates.entries()) {
      if (expiresAtMs <= currentTime) {
        expiredStates.delete(state);
      }
    }
  }

  function createAuthorizationAttempt(discordId) {
    cleanupStates();
    if (!isEnabled()) {
      throw createError('LIVEPIX_OAUTH_DISABLED', 'Integração LivePix individual desativada.', 503);
    }
    if (typeof discordId !== 'string' || !discordId.trim()) {
      throw createError('INVALID_DISCORD_ID', 'Discord ID inválido.');
    }

    let state;
    do {
      state = base64UrlEncode(randomBytes(32));
    } while (pendingStates.has(state) || usedStates.has(state) || expiredStates.has(state));
    const createdAtMs = now();
    const expiresAtMs = createdAtMs + STATE_TTL_MS;
    pendingStates.set(state, { discordId: discordId.trim(), createdAtMs, expiresAtMs });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.livepixClientId,
      redirect_uri: cfg.livepixRedirectUri,
      scope: (cfg.livepixLinkOauthScopes || ['account:read']).join(' '),
      state,
    });

    return {
      state,
      expiresAtMs,
      ttlMs: STATE_TTL_MS,
      authorizationUrl: `https://oauth.livepix.gg/oauth2/auth?${params.toString()}`,
    };
  }

  function consumeValidState(state) {
    cleanupStates();
    if (typeof state !== 'string' || !state) {
      throw createError('STATE_INVALID', 'State inválido.');
    }
    if (usedStates.has(state)) {
      throw createError('STATE_REUSED', 'State já utilizado.');
    }
    if (expiredStates.has(state)) {
      throw createError('STATE_EXPIRED', 'State expirado.');
    }
    const attempt = pendingStates.get(state);
    if (!attempt) {
      throw createError('STATE_INVALID', 'State inválido.');
    }
    if (attempt.expiresAtMs <= now()) {
      pendingStates.delete(state);
      throw createError('STATE_EXPIRED', 'State expirado.');
    }

    pendingStates.delete(state);
    usedStates.set(state, attempt.expiresAtMs);
    return attempt;
  }

  async function completeOAuthCallback(payload) {
    if (!payload || typeof payload !== 'object') {
      throw createError('CALLBACK_INVALID', 'Parâmetros inválidos no callback.');
    }

    const attempt = consumeValidState(payload.state);
    if (typeof payload.error === 'string' && payload.error) {
      if (payload.error === 'access_denied') {
        throw createError('OAUTH_CANCELLED', 'Autorização LivePix cancelada pelo usuário.');
      }
      throw createError('OAUTH_PROVIDER_ERROR', 'A LivePix não autorizou a solicitação.');
    }
    if (typeof payload.code !== 'string' || !payload.code.trim()) {
      throw createError('MISSING_CODE', 'Código de autorização ausente.');
    }
    if (!isEnabled()) {
      throw createError('LIVEPIX_OAUTH_DISABLED', 'Integração LivePix individual desativada.', 503);
    }

    const token = await apiService.exchangeAuthorizationCodeToken({
      clientId: cfg.livepixClientId,
      clientSecret: cfg.livepixClientSecret,
      redirectUri: cfg.livepixRedirectUri,
      code: payload.code.trim(),
    });
    const livepixAccountId = await apiService.getAccountId(token.accessToken);
    const saved = repository.createLink({
      discordId: attempt.discordId,
      livepixAccountId,
      createdAtMs: now(),
      updatedAtMs: now(),
    });

    return { discordId: saved.discord_id, livepixAccountId: saved.livepix_account_id };
  }

  return {
    isEnabled,
    createAuthorizationAttempt,
    consumeValidState,
    completeOAuthCallback,
    stateTtlMs: STATE_TTL_MS,
    _resetForTests() {
      pendingStates.clear();
      usedStates.clear();
      expiredStates.clear();
    },
  };
}

const defaultService = createLivePixLinkAuthService();
defaultService.createLivePixLinkAuthService = createLivePixLinkAuthService;
defaultService.LivePixLinkAuthError = LivePixLinkAuthError;

module.exports = defaultService;
