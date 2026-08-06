const config = require('../config');
const kickApiServiceModule = require('./kickApiService');

class KickAppTokenError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'KickAppTokenError';
    this.code = code;
    this.httpStatus = options.httpStatus || 500;
    this.category = options.category || 'kick_app_token_error';
    this.missingVar = options.missingVar || null;
  }
}

function createKickAppTokenService(options = {}) {
  const cfg = options.config || config;
  const now = options.now || (() => Date.now());
  const refreshSkewMs = Number(options.refreshSkewMs || 60_000);
  const timeoutMs = Number(options.timeoutMs || 10_000);

  const kickApiService =
    options.kickApiService ||
    kickApiServiceModule.createKickApiService({
      fetchImpl: options.fetchImpl,
      timeoutMs,
      oauthBaseUrl: options.oauthBaseUrl,
      apiBaseUrl: options.apiBaseUrl,
    });

  let cachedAccessToken = null;
  let expiresAtMs = 0;

  function requireNonEmptyConfigValue(value, envName) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new KickAppTokenError(
        'MISSING_CONFIG',
        `Configuração obrigatória ausente: ${envName}.`,
        {
          httpStatus: 503,
          category: 'missing_config',
          missingVar: envName,
        },
      );
    }

    return value.trim();
  }

  function invalidateToken() {
    cachedAccessToken = null;
    expiresAtMs = 0;
  }

  function isTokenValid(referenceNow) {
    return Boolean(cachedAccessToken) && referenceNow < expiresAtMs - refreshSkewMs;
  }

  async function getAccessToken() {
    const currentNow = now();
    if (isTokenValid(currentNow)) {
      return cachedAccessToken;
    }

    const clientId = requireNonEmptyConfigValue(cfg.kickClientId, 'KICK_CLIENT_ID');
    const clientSecret = requireNonEmptyConfigValue(cfg.kickClientSecret, 'KICK_CLIENT_SECRET');

    let tokenResponse;
    try {
      tokenResponse = await kickApiService.exchangeClientCredentialsToken({
        clientId,
        clientSecret,
      });
    } catch (error) {
      if (error?.code === 'UNAUTHORIZED' || error?.code === 'FORBIDDEN') {
        invalidateToken();
      }
      throw error;
    }

    if (
      !tokenResponse ||
      typeof tokenResponse.accessToken !== 'string' ||
      !tokenResponse.accessToken.trim()
    ) {
      invalidateToken();
      throw new KickAppTokenError(
        'INVALID_TOKEN_RESPONSE',
        'Resposta inválida de token da Kick API.',
        {
          httpStatus: 502,
          category: 'invalid_token_response',
        },
      );
    }

    const expiresInSeconds = Number(tokenResponse.expiresIn);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      invalidateToken();
      throw new KickAppTokenError(
        'INVALID_TOKEN_RESPONSE',
        'Resposta inválida de token da Kick API.',
        {
          httpStatus: 502,
          category: 'invalid_token_response',
        },
      );
    }

    cachedAccessToken = tokenResponse.accessToken.trim();
    expiresAtMs = currentNow + Math.trunc(expiresInSeconds * 1000);

    return cachedAccessToken;
  }

  return {
    getAccessToken,
    invalidateToken,
  };
}

const defaultService = createKickAppTokenService();
defaultService.createKickAppTokenService = createKickAppTokenService;
defaultService.KickAppTokenError = KickAppTokenError;

module.exports = defaultService;
