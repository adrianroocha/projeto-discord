class KickApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'KickApiError';
    this.code = code;
    this.httpStatus = options.httpStatus || 500;
    this.category = options.category || 'kick_api_error';
  }
}

function createKickApiService(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const timeoutMs = Number(options.timeoutMs || 10_000);
  const oauthBaseUrl = (options.oauthBaseUrl || 'https://id.kick.com').replace(/\/$/, '');
  const apiBaseUrl = (options.apiBaseUrl || 'https://api.kick.com/public/v1').replace(/\/$/, '');

  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API não está disponível para integração Kick.');
  }

  async function requestJson(url, requestOptions = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        ...requestOptions,
        signal: controller.signal,
      });

      const rawBody = await response.text();
      let parsedBody = null;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch (error) {
          parsedBody = null;
        }
      }

      if (!response.ok) {
        throw mapHttpError(response.status);
      }

      if (!parsedBody || typeof parsedBody !== 'object') {
        throw new KickApiError('INVALID_JSON_RESPONSE', 'Resposta inválida da Kick API.', {
          httpStatus: 502,
          category: 'invalid_json_response',
        });
      }

      return parsedBody;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new KickApiError('REQUEST_TIMEOUT', 'Tempo limite excedido ao consultar Kick API.', {
          httpStatus: 504,
          category: 'timeout',
        });
      }

      if (error instanceof KickApiError) {
        throw error;
      }

      throw new KickApiError('NETWORK_ERROR', 'Falha de rede ao consultar Kick API.', {
        httpStatus: 503,
        category: 'network_error',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function mapHttpError(status) {
    if (status === 400) {
      return new KickApiError('BAD_REQUEST', 'Requisição inválida para Kick API.', {
        httpStatus: 400,
        category: 'bad_request',
      });
    }

    if (status === 401) {
      return new KickApiError('UNAUTHORIZED', 'Não autorizado pela Kick API.', {
        httpStatus: 401,
        category: 'unauthorized',
      });
    }

    if (status === 403) {
      return new KickApiError('FORBIDDEN', 'Acesso negado pela Kick API.', {
        httpStatus: 403,
        category: 'forbidden',
      });
    }

    if (status === 429) {
      return new KickApiError('RATE_LIMITED', 'Limite de requisições atingido na Kick API.', {
        httpStatus: 429,
        category: 'rate_limited',
      });
    }

    if (status >= 500) {
      return new KickApiError('UPSTREAM_UNAVAILABLE', 'Serviço da Kick indisponível.', {
        httpStatus: 502,
        category: 'upstream_unavailable',
      });
    }

    return new KickApiError('UPSTREAM_ERROR', 'Erro inesperado da Kick API.', {
      httpStatus: 502,
      category: 'upstream_error',
    });
  }

  async function exchangeAuthorizationCode(payload) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: payload.clientId,
      client_secret: payload.clientSecret,
      redirect_uri: payload.redirectUri,
      code_verifier: payload.codeVerifier,
      code: payload.code,
    });

    const body = await requestJson(`${oauthBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    if (!body.access_token || typeof body.access_token !== 'string') {
      throw new KickApiError('INVALID_TOKEN_RESPONSE', 'Resposta de token inválida da Kick API.', {
        httpStatus: 502,
        category: 'invalid_token_response',
      });
    }

    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      tokenType: typeof body.token_type === 'string' ? body.token_type : null,
      scope: typeof body.scope === 'string' ? body.scope : null,
      expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
    };
  }

  async function getAuthorizedUser(accessToken) {
    const body = await requestJson(`${apiBaseUrl}/users`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!Array.isArray(body.data) || body.data.length === 0 || typeof body.data[0] !== 'object') {
      throw new KickApiError('INVALID_USER_RESPONSE', 'Resposta de usuário inválida da Kick API.', {
        httpStatus: 502,
        category: 'invalid_user_response',
      });
    }

    const firstUser = body.data[0];
    const kickUserId = firstUser.user_id;
    const kickUsername =
      typeof firstUser.name === 'string' && firstUser.name.trim()
        ? firstUser.name.trim()
        : typeof firstUser.username === 'string' && firstUser.username.trim()
          ? firstUser.username.trim()
          : null;

    if (!Number.isInteger(kickUserId) || !kickUsername) {
      throw new KickApiError('INVALID_USER_RESPONSE', 'Resposta de usuário inválida da Kick API.', {
        httpStatus: 502,
        category: 'invalid_user_response',
      });
    }

    return {
      kickUserId: String(kickUserId),
      kickUsername,
    };
  }

  return {
    exchangeAuthorizationCode,
    getAuthorizedUser,
  };
}

const defaultService = createKickApiService();

defaultService.KickApiError = KickApiError;
defaultService.createKickApiService = createKickApiService;

module.exports = defaultService;
