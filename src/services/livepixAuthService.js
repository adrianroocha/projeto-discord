const config = require('../config');
const livepixApiServiceModule = require('./livepixApiService');

class LivePixAuthError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'LivePixAuthError';
    this.code = code;
    this.httpStatus = options.httpStatus || 500;
    this.category = options.category || 'livepix_auth_error';
    this.missingVar = options.missingVar || null;
  }
}

function createLivePixAuthService(options = {}) {
  const cfg = options.config || config;
  const now = options.now || (() => Date.now());
  const refreshSkewMs = Number(options.refreshSkewMs || 60_000);
  const apiService =
    options.livepixApiService ||
    livepixApiServiceModule.createLivePixApiService({
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      oauthBaseUrl: options.oauthBaseUrl,
      apiBaseUrl: options.apiBaseUrl,
    });

  let cachedAccessToken = null;
  let expiresAtMs = 0;
  let refreshAtMs = 0;
  let pendingTokenRequest = null;

  function requireConfigValue(value, envName) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new LivePixAuthError('MISSING_CONFIG', `Configuração LivePix ausente: ${envName}.`, {
        httpStatus: 503,
        category: 'missing_config',
        missingVar: envName,
      });
    }

    return value.trim();
  }

  function invalidateAccessToken() {
    cachedAccessToken = null;
    expiresAtMs = 0;
    refreshAtMs = 0;
  }

  function isTokenValid(referenceNow) {
    return Boolean(cachedAccessToken) && referenceNow < refreshAtMs;
  }

  async function getAccessToken() {
    const currentNow = now();
    if (isTokenValid(currentNow)) {
      return cachedAccessToken;
    }

    if (pendingTokenRequest) {
      return pendingTokenRequest;
    }

    const tokenRequestStartedAt = currentNow;
    const clientId = requireConfigValue(cfg.livepixClientId, 'LIVEPIX_CLIENT_ID');
    const clientSecret = requireConfigValue(cfg.livepixClientSecret, 'LIVEPIX_CLIENT_SECRET');
    const scopes = Array.isArray(cfg.livepixOauthScopes)
      ? cfg.livepixOauthScopes.filter((scope) => typeof scope === 'string' && scope.trim())
      : [];
    const pendingRequest = Promise.resolve().then(async () => {
      try {
        const token = await apiService.exchangeClientCredentialsToken({
          clientId,
          clientSecret,
          scope: scopes.join(' '),
        });

        if (
          !token ||
          typeof token.accessToken !== 'string' ||
          !token.accessToken.trim() ||
          !Number.isSafeInteger(Number(token.expiresIn)) ||
          Number(token.expiresIn) <= 0 ||
          !Number.isSafeInteger(Number(token.expiresIn) * 1000) ||
          !Number.isSafeInteger(
            tokenRequestStartedAt + Number(token.expiresIn) * 1000,
          )
        ) {
          throw new LivePixAuthError(
            'INVALID_TOKEN_RESPONSE',
            'Resposta de token inválida da LivePix API.',
            { httpStatus: 502, category: 'invalid_token_response' },
          );
        }

        cachedAccessToken = token.accessToken.trim();
        const expiresInMs = Number(token.expiresIn) * 1000;
        expiresAtMs = tokenRequestStartedAt + expiresInMs;
        const earlyRefreshMs = Math.min(refreshSkewMs, Math.floor(expiresInMs * 0.1));
        refreshAtMs = expiresAtMs - earlyRefreshMs;
        return cachedAccessToken;
      } finally {
        pendingTokenRequest = null;
      }
    });

    pendingTokenRequest = pendingRequest;
    return pendingRequest;
  }

  async function getAuthenticatedAccount() {
    const accessToken = await getAccessToken();

    try {
      return await apiService.getAccount(accessToken);
    } catch (error) {
      if (error?.code === 'UNAUTHORIZED') {
        invalidateAccessToken();
      }
      throw error;
    }
  }

  return {
    getAccessToken,
    getAuthenticatedAccount,
    invalidateAccessToken,
  };
}

const defaultService = createLivePixAuthService();
defaultService.createLivePixAuthService = createLivePixAuthService;
defaultService.LivePixAuthError = LivePixAuthError;

module.exports = defaultService;
