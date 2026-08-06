class KickApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'KickApiError';
    this.code = code;
    this.httpStatus = options.httpStatus || 500;
    this.category = options.category || 'kick_api_error';
  }
}

function toPositiveInteger(value) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
}

function toSafeString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = String(value).trim();
  return parsed || null;
}

function normalizeKickError(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    return toSafeString(value);
  }

  const parsed = value.trim();
  return parsed || null;
}

function getEventNameFromGetEntry(entry) {
  if (typeof entry?.event === 'string' && entry.event.trim()) {
    return entry.event.trim();
  }

  if (typeof entry?.name === 'string' && entry.name.trim()) {
    return entry.name.trim();
  }

  if (typeof entry?.event_name === 'string' && entry.event_name.trim()) {
    return entry.event_name.trim();
  }

  if (typeof entry?.event?.name === 'string' && entry.event.name.trim()) {
    return entry.event.name.trim();
  }

  return null;
}

function getEventNameFromPostEntry(entry) {
  if (typeof entry?.name === 'string' && entry.name.trim()) {
    return entry.name.trim();
  }

  if (typeof entry?.event === 'string' && entry.event.trim()) {
    return entry.event.trim();
  }

  if (typeof entry?.event_name === 'string' && entry.event_name.trim()) {
    return entry.event_name.trim();
  }

  if (typeof entry?.event?.name === 'string' && entry.event.name.trim()) {
    return entry.event.name.trim();
  }

  return null;
}

function normalizeGetSubscription(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const eventName = getEventNameFromGetEntry(entry);

  const eventVersionRaw = entry?.event?.version ?? entry?.version ?? entry?.event_version;
  const eventVersion = toPositiveInteger(eventVersionRaw);

  const broadcasterUserIdRaw =
    entry?.broadcaster_user_id ?? entry?.broadcaster?.user_id ?? entry?.broadcasterId;
  const broadcasterUserId =
    broadcasterUserIdRaw === null || broadcasterUserIdRaw === undefined
      ? null
      : String(broadcasterUserIdRaw).trim();

  if (!eventName || !eventVersion || !broadcasterUserId) {
    return null;
  }

  return {
    name: eventName,
    version: eventVersion,
    broadcasterUserId,
    subscriptionId: toSafeString(entry?.id ?? entry?.subscription_id),
    method: typeof entry.method === 'string' ? entry.method : null,
  };
}

function normalizePostSubscriptionResult(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const name = getEventNameFromPostEntry(entry);
  const version = toPositiveInteger(entry?.version ?? entry?.event?.version ?? entry?.event_version);
  const subscriptionId = toSafeString(entry?.subscription_id ?? entry?.id);
  const error = normalizeKickError(entry?.error);

  return {
    name,
    version,
    subscriptionId,
    error,
    confirmed: Boolean(name && version && subscriptionId && !error),
  };
}

function normalizeTopLevelMessage(body) {
  return typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : null;
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
    const response = await requestJsonDetailed(url, requestOptions);
    return response.body;
  }

  async function requestJsonDetailed(url, requestOptions = {}) {
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
        throw mapHttpError(response.status, parsedBody);
      }

      if (!parsedBody || typeof parsedBody !== 'object') {
        throw new KickApiError('INVALID_JSON_RESPONSE', 'Resposta inválida da Kick API.', {
          httpStatus: 502,
          category: 'invalid_json_response',
        });
      }

      return {
        status: response.status,
        body: parsedBody,
      };
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

  function mapHttpError(status, parsedBody) {
    const upstreamMessage = normalizeTopLevelMessage(parsedBody);

    if (status === 400) {
      const error = new KickApiError('BAD_REQUEST', 'Requisição inválida para Kick API.', {
        httpStatus: 400,
        category: 'bad_request',
      });
      error.upstreamMessage = upstreamMessage;
      return error;
    }

    if (status === 401) {
      const error = new KickApiError('UNAUTHORIZED', 'Não autorizado pela Kick API.', {
        httpStatus: 401,
        category: 'unauthorized',
      });
      error.upstreamMessage = upstreamMessage;
      return error;
    }

    if (status === 403) {
      const error = new KickApiError('FORBIDDEN', 'Acesso negado pela Kick API.', {
        httpStatus: 403,
        category: 'forbidden',
      });
      error.upstreamMessage = upstreamMessage;
      return error;
    }

    if (status === 429) {
      const error = new KickApiError('RATE_LIMITED', 'Limite de requisições atingido na Kick API.', {
        httpStatus: 429,
        category: 'rate_limited',
      });
      error.upstreamMessage = upstreamMessage;
      return error;
    }

    if (status >= 500) {
      const error = new KickApiError('UPSTREAM_UNAVAILABLE', 'Serviço da Kick indisponível.', {
        httpStatus: 502,
        category: 'upstream_unavailable',
      });
      error.upstreamMessage = upstreamMessage;
      return error;
    }

    const error = new KickApiError('UPSTREAM_ERROR', 'Erro inesperado da Kick API.', {
      httpStatus: 502,
      category: 'upstream_error',
    });
    error.upstreamMessage = upstreamMessage;
    return error;
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

  async function exchangeClientCredentialsToken(payload) {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: payload.clientId,
      client_secret: payload.clientSecret,
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

  async function listEventSubscriptions(payload) {
    const broadcasterUserId = Number(payload.broadcasterUserId);
    const params = new URLSearchParams();

    if (Number.isInteger(broadcasterUserId) && broadcasterUserId > 0) {
      params.set('broadcaster_user_id', String(broadcasterUserId));
    }

    const query = params.toString();
    const response = await requestJsonDetailed(
      `${apiBaseUrl}/events/subscriptions${query ? `?${query}` : ''}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${payload.accessToken}`,
          Accept: 'application/json',
        },
      },
    );

    const body = response.body;

    if (!Array.isArray(body.data)) {
      throw new KickApiError(
        'INVALID_SUBSCRIPTIONS_RESPONSE',
        'Resposta inválida ao consultar subscriptions da Kick API.',
        {
          httpStatus: 502,
          category: 'invalid_subscriptions_response',
        },
      );
    }

    const subscriptions = body.data
      .map((entry) => normalizeGetSubscription(entry))
      .filter(Boolean);

    const diagnostics = body.data.map((entry) => {
      const normalized = normalizeGetSubscription(entry) || {};
      return {
        name: normalized.name || null,
        version: Number.isInteger(normalized.version) ? normalized.version : null,
        subscriptionIdPresent: Boolean(normalized.subscriptionId),
        error: normalizeKickError(entry?.error),
      };
    });

    return {
      status: response.status,
      message: normalizeTopLevelMessage(body),
      subscriptions,
      diagnostics,
    };
  }

  async function createEventSubscriptions(payload) {
    const response = await requestJsonDetailed(`${apiBaseUrl}/events/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${payload.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        broadcaster_user_id: payload.broadcasterUserId,
        method: 'webhook',
        events: payload.events,
      }),
    });

    const body = response.body;

    if (!Array.isArray(body.data)) {
      throw new KickApiError(
        'INVALID_SUBSCRIPTIONS_RESPONSE',
        'Resposta inválida ao criar subscriptions da Kick API.',
        {
          httpStatus: 502,
          category: 'invalid_subscriptions_response',
        },
      );
    }

    const results = body.data
      .map((entry) => normalizePostSubscriptionResult(entry))
      .filter(Boolean);

    const diagnostics = results.map((item) => ({
      name: item.name,
      version: item.version,
      subscriptionIdPresent: Boolean(item.subscriptionId),
      error: item.error,
    }));

    return {
      status: response.status,
      message: normalizeTopLevelMessage(body),
      results,
      diagnostics,
    };
  }

  return {
    exchangeAuthorizationCode,
    exchangeClientCredentialsToken,
    getAuthorizedUser,
    listEventSubscriptions,
    createEventSubscriptions,
  };
}

const defaultService = createKickApiService();

defaultService.KickApiError = KickApiError;
defaultService.createKickApiService = createKickApiService;

module.exports = defaultService;
