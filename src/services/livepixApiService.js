class LivePixApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'LivePixApiError';
    this.code = code;
    this.httpStatus = options.httpStatus || 500;
    this.category = options.category || 'livepix_api_error';
  }
}

function createLivePixApiService(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const timeoutMs = Number(options.timeoutMs || 10_000);
  const oauthBaseUrl = (options.oauthBaseUrl || 'https://oauth.livepix.gg').replace(/\/$/, '');
  const apiBaseUrl = (options.apiBaseUrl || 'https://api.livepix.gg').replace(/\/$/, '');

  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API não está disponível para integração LivePix.');
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
      let body = null;

      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = null;
        }
      }

      if (!response.ok) {
        throw mapHttpError(response.status);
      }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new LivePixApiError('INVALID_JSON_RESPONSE', 'Resposta inválida da LivePix API.', {
          httpStatus: 502,
          category: 'invalid_json_response',
        });
      }

      return body;
    } catch (error) {
      if (error instanceof LivePixApiError) {
        throw error;
      }

      if (error?.name === 'AbortError') {
        throw new LivePixApiError('REQUEST_TIMEOUT', 'Tempo limite excedido na LivePix API.', {
          httpStatus: 504,
          category: 'timeout',
        });
      }

      throw new LivePixApiError('NETWORK_ERROR', 'Falha de rede na LivePix API.', {
        httpStatus: 503,
        category: 'network_error',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function mapHttpError(status) {
    if (status === 401) {
      return new LivePixApiError('UNAUTHORIZED', 'A LivePix recusou a autenticação.', {
        httpStatus: 401,
        category: 'unauthorized',
      });
    }

    if (status === 403) {
      return new LivePixApiError('FORBIDDEN', 'A LivePix recusou a autorização.', {
        httpStatus: 403,
        category: 'forbidden',
      });
    }

    if (status === 429) {
      return new LivePixApiError('RATE_LIMITED', 'Limite de requisições da LivePix atingido.', {
        httpStatus: 429,
        category: 'rate_limited',
      });
    }

    if (status >= 500) {
      return new LivePixApiError('UPSTREAM_UNAVAILABLE', 'A LivePix API está indisponível.', {
        httpStatus: 502,
        category: 'upstream_unavailable',
      });
    }

    return new LivePixApiError('UPSTREAM_ERROR', 'A LivePix API rejeitou a requisição.', {
      httpStatus: 502,
      category: 'upstream_error',
    });
  }

  async function exchangeClientCredentialsToken(payload) {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: payload.clientId,
      client_secret: payload.clientSecret,
    });

    if (typeof payload.scope === 'string' && payload.scope.trim()) {
      form.set('scope', payload.scope.trim());
    }

    const body = await requestJson(`${oauthBaseUrl}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });
    const expiresIn = Number(body.expires_in);

    if (
      typeof body.access_token !== 'string' ||
      !body.access_token.trim() ||
      typeof body.token_type !== 'string' ||
      body.token_type.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new LivePixApiError('INVALID_TOKEN_RESPONSE', 'Resposta de token inválida da LivePix API.', {
        httpStatus: 502,
        category: 'invalid_token_response',
      });
    }

    return {
      accessToken: body.access_token.trim(),
      tokenType: body.token_type,
      scope: typeof body.scope === 'string' ? body.scope : null,
      expiresIn,
    };
  }

  async function getAccount(accessToken) {
    const body = await requestJson(`${apiBaseUrl}/v2/account`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    const account = body.data;

    if (
      !account ||
      typeof account !== 'object' ||
      Array.isArray(account) ||
      typeof account.id !== 'string' ||
      !account.id.trim() ||
      typeof account.username !== 'string' ||
      !account.username.trim() ||
      (account.displayName !== undefined &&
        account.displayName !== null &&
        typeof account.displayName !== 'string')
    ) {
      throw new LivePixApiError('INVALID_ACCOUNT_RESPONSE', 'Resposta de conta inválida da LivePix API.', {
        httpStatus: 502,
        category: 'invalid_account_response',
      });
    }

    return {
      id: account.id.trim(),
      username: account.username.trim(),
      displayName: typeof account.displayName === 'string' ? account.displayName.trim() : null,
    };
  }

  return {
    exchangeClientCredentialsToken,
    getAccount,
  };
}

const defaultService = createLivePixApiService();
defaultService.LivePixApiError = LivePixApiError;
defaultService.createLivePixApiService = createLivePixApiService;

module.exports = defaultService;
