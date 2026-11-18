class LivePixApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'LivePixApiError';
    this.code = code;
    this.httpStatus = options.httpStatus || 500;
    this.category = options.category || 'livepix_api_error';
    this.rateLimitHeaders = options.rateLimitHeaders || null;
    this.cooldownUntil = options.cooldownUntil || null;
  }
}

function createLivePixApiService(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const timeoutMs = Number(options.timeoutMs || 10_000);
  const oauthBaseUrl = (options.oauthBaseUrl || 'https://oauth.livepix.gg').replace(/\/$/, '');
  const apiBaseUrl = (options.apiBaseUrl || 'https://api.livepix.gg').replace(/\/$/, '');
  const logger = options.logger || console;
  const subscriptionStatuses = new Set(['active', 'pending', 'cancelled']);
  const recurrences = new Set(['monthly', 'quarterly', 'semiannual', 'yearly']);
  const endpointCooldowns = new Map();
  const endpointLocks = new Map();

  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API não está disponível para integração LivePix.');
  }

  function invalidRequestOptions() {
    return new LivePixApiError('INVALID_REQUEST_OPTIONS', 'Parâmetros inválidos para consulta LivePix.', {
      httpStatus: 400,
      category: 'invalid_request_options',
    });
  }

  function invalidResponse(code, message) {
    return new LivePixApiError(code, message, {
      httpStatus: 502,
      category: 'invalid_api_response',
    });
  }

  function isObjectId(value) {
    return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
  }

  function isDateTime(value) {
    if (typeof value !== 'string') {
      return false;
    }

    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/);
    if (!match) {
      return false;
    }

    const [
      ,
      yearValue,
      monthValue,
      dayValue,
      hourValue,
      minuteValue,
      secondValue,
      ,
      ,
      offsetHourValue,
      offsetMinuteValue,
    ] = match;
    const year = Number(yearValue);
    const month = Number(monthValue);
    const day = Number(dayValue);
    const hour = Number(hourValue);
    const minute = Number(minuteValue);
    const second = Number(secondValue);
    const daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) {
      daysPerMonth[1] = 29;
    }

    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysPerMonth[month - 1] &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59 &&
      (!offsetHourValue || (Number(offsetHourValue) <= 23 && Number(offsetMinuteValue) <= 59)) &&
      !Number.isNaN(Date.parse(value))
    );
  }

  function validateQueryOptions(options, allowedKeys, validators) {
    if (options === undefined) {
      return '';
    }

    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw invalidRequestOptions();
    }

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) {
        continue;
      }

      if (!allowedKeys.has(key) || !validators[key](value)) {
        throw invalidRequestOptions();
      }
      query.set(key, String(value));
    }

    const serialized = query.toString();
    return serialized ? `?${serialized}` : '';
  }

  function validatePagination(options, additionalValidators = {}) {
    return validateQueryOptions(options, new Set(['page', 'limit', ...Object.keys(additionalValidators)]), {
      page: (value) => Number.isSafeInteger(value) && value >= 1,
      limit: (value) => Number.isSafeInteger(value) && value >= 1 && value <= 100,
      ...additionalValidators,
    });
  }

  function requireAccessToken(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      throw new LivePixApiError('INVALID_ACCESS_TOKEN', 'Token de acesso LivePix inválido.', {
        httpStatus: 401,
        category: 'unauthorized',
      });
    }
  }

  function isSubscription(subscription) {
    return (
      subscription &&
      typeof subscription === 'object' &&
      !Array.isArray(subscription) &&
      isObjectId(subscription.id) &&
      (!Object.prototype.hasOwnProperty.call(subscription, 'subscriber') ||
        (typeof subscription.subscriber === 'string' &&
          subscription.subscriber.length >= 1 &&
          subscription.subscriber.length <= 72)) &&
      Number.isSafeInteger(subscription.months) &&
      subscription.months >= 0 &&
      typeof subscription.currency === 'string' &&
      /^[A-Z]{3}$/.test(subscription.currency) &&
      Number.isSafeInteger(subscription.amount) &&
      subscription.amount >= 1 &&
      recurrences.has(subscription.recurrence) &&
      typeof subscription.status === 'string' &&
      subscriptionStatuses.has(subscription.status.toLowerCase()) &&
      isDateTime(subscription.renewAt) &&
      isDateTime(subscription.updatedAt) &&
      isDateTime(subscription.createdAt)
    );
  }

  function isPlanAmount(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0;
    }

    return typeof value === 'string' && value.length > 0 && value.trim() === value && /^[0-9]+$/.test(value);
  }

  function isSubscriptionPlan(plan) {
    return (
      plan &&
      typeof plan === 'object' &&
      !Array.isArray(plan) &&
      typeof plan.id === 'string' &&
      plan.id.length > 0 &&
      typeof plan.slug === 'string' &&
      plan.slug.length >= 1 &&
      typeof plan.name === 'string' &&
      plan.name.length >= 1 &&
      typeof plan.description === 'string' &&
      isPlanAmount(plan.amount) &&
      typeof plan.currency === 'string' &&
      /^[A-Z]{3}$/.test(plan.currency) &&
      isDateTime(plan.createdAt)
    );
  }

  function getValueType(value) {
    if (value === null) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'array';
    }
    return typeof value;
  }

  function describeFieldTypes(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return 'none';
    }

    const entries = Object.entries(value);
    const fields = entries.slice(0, 20).map(([key, fieldValue]) => {
      const safeKey = key.replace(/[^a-zA-Z0-9_$-]/g, '_').slice(0, 40) || 'unknown';
      return `${safeKey}:${getValueType(fieldValue)}`;
    });

    if (entries.length > fields.length) {
      fields.push('more');
    }
    return fields.join(',') || 'none';
  }

  function logInvalidPlansResponse(status, body) {
    const data = body.data;
    const itemShapes = new Set();
    if (Array.isArray(data)) {
      for (const item of data) {
        itemShapes.add(describeFieldTypes(item));
        if (itemShapes.size >= 5) {
          break;
        }
      }
    }

    logger.warn(
      [
        'LivePix plans response invalid',
        `status=${status}`,
        `root_fields=${describeFieldTypes(body)}`,
        `data_type=${getValueType(data)}`,
        `item_count=${Array.isArray(data) ? data.length : 'n/a'}`,
        `item_fields=${itemShapes.size > 0 ? [...itemShapes].join('|') : 'none'}`,
      ].join(' '),
    );
  }

  function isSubscriptionTransaction(transaction) {
    return (
      transaction &&
      typeof transaction === 'object' &&
      !Array.isArray(transaction) &&
      typeof transaction.id === 'string' &&
      transaction.id.length > 0 &&
      typeof transaction.proof === 'string' &&
      transaction.proof.length > 0 &&
      Number.isSafeInteger(transaction.amount) &&
      transaction.amount >= 1 &&
      isDateTime(transaction.createdAt)
    );
  }

  function validateDataArray(body, validator, code, message) {
    if (!Array.isArray(body.data) || !body.data.every(validator)) {
      throw invalidResponse(code, message);
    }
    return body.data;
  }

  function getEndpointCooldown(endpoint) {
    const cooldownUntil = endpointCooldowns.get(endpoint);
    if (!cooldownUntil || cooldownUntil <= Date.now()) {
      endpointCooldowns.delete(endpoint);
      return null;
    }
    return cooldownUntil;
  }

  function getHeader(response, name) {
    const value =
      typeof response.headers?.get === 'function'
        ? response.headers.get(name)
        : response.headers?.[name] || response.headers?.[name.toLowerCase()];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  function parseRateLimitReset(value) {
    if (!value || !/^\d+(?:\.\d+)?$/.test(value)) {
      return null;
    }
    const resetAt = Number(value) * 1000;
    return Number.isSafeInteger(resetAt) && resetAt <= 8.64e15 ? resetAt : null;
  }

  function rateLimitedError(rateLimitHeaders, cooldownUntil = null) {
    return new LivePixApiError('RATE_LIMITED', 'Limite de requisições da LivePix atingido.', {
      httpStatus: 429,
      category: 'rate_limited',
      rateLimitHeaders,
      cooldownUntil,
    });
  }

  async function requestJson(url, requestOptions = {}, onHttpStatus, endpointKey) {
    const endpoint = endpointKey || new URL(url).pathname;
    const previousRequest = endpointLocks.get(endpoint) || Promise.resolve();
    let releaseRequest;
    const currentRequest = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    endpointLocks.set(endpoint, currentRequest);

    try {
      await previousRequest;
      const activeCooldown = getEndpointCooldown(endpoint);
      if (activeCooldown) {
        throw rateLimitedError(null, activeCooldown);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          ...requestOptions,
          signal: controller.signal,
        });
        if (typeof onHttpStatus === 'function') {
          onHttpStatus(response.status);
        }

        const rateLimitHeaders = {
          'X-RateLimit-Limit': getHeader(response, 'X-RateLimit-Limit'),
          'X-RateLimit-Remaining': getHeader(response, 'X-RateLimit-Remaining'),
          'X-RateLimit-Reset': getHeader(response, 'X-RateLimit-Reset'),
        };
        const resetAt = parseRateLimitReset(rateLimitHeaders['X-RateLimit-Reset']);
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
          if (response.status === 429) {
            const cooldownUntil = resetAt > Date.now() ? resetAt : null;
            if (cooldownUntil) {
              endpointCooldowns.set(endpoint, cooldownUntil);
            }
            throw rateLimitedError(rateLimitHeaders, cooldownUntil);
          }
          throw mapHttpError(response.status);
        }

        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new LivePixApiError('INVALID_JSON_RESPONSE', 'Resposta inválida da LivePix API.', {
            httpStatus: 502,
            category: 'invalid_json_response',
          });
        }

        return body;
      } finally {
        clearTimeout(timer);
      }
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
      releaseRequest();
      if (endpointLocks.get(endpoint) === currentRequest) {
        endpointLocks.delete(endpoint);
      }
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
      return rateLimitedError(null);
    }

    if (status === 400 || status === 422) {
      return new LivePixApiError('BAD_REQUEST', 'A LivePix rejeitou os parâmetros da requisição.', {
        httpStatus: status,
        category: 'bad_request',
      });
    }

    if (status === 404) {
      return new LivePixApiError('NOT_FOUND', 'O recurso solicitado não foi encontrado na LivePix.', {
        httpStatus: 404,
        category: 'not_found',
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
    const expiresIn = body.expires_in;

    if (
      typeof body.access_token !== 'string' ||
      !body.access_token.trim() ||
      typeof body.token_type !== 'string' ||
      body.token_type.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(expiresIn) ||
      expiresIn <= 0 ||
      (Object.prototype.hasOwnProperty.call(body, 'scope') && typeof body.scope !== 'string')
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

  async function exchangeAuthorizationCodeToken(payload) {
    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.clientId !== 'string' ||
      !payload.clientId.trim() ||
      typeof payload.clientSecret !== 'string' ||
      !payload.clientSecret.trim() ||
      typeof payload.code !== 'string' ||
      !payload.code.trim() ||
      typeof payload.redirectUri !== 'string' ||
      !payload.redirectUri.trim() ||
      payload.redirectUri !== payload.redirectUri.trim()
    ) {
      throw invalidRequestOptions();
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: payload.clientId.trim(),
      client_secret: payload.clientSecret,
      code: payload.code.trim(),
      redirect_uri: payload.redirectUri,
    });
    const body = await requestJson(`${oauthBaseUrl}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });

    if (
      typeof body.access_token !== 'string' ||
      !body.access_token.trim() ||
      typeof body.token_type !== 'string' ||
      body.token_type.toLowerCase() !== 'bearer'
    ) {
      throw new LivePixApiError('INVALID_TOKEN_RESPONSE', 'Resposta de token inválida da LivePix API.', {
        httpStatus: 502,
        category: 'invalid_token_response',
      });
    }

    return { accessToken: body.access_token.trim() };
  }

  async function getAccountId(accessToken) {
    requireAccessToken(accessToken);
    const body = await requestJson(`${apiBaseUrl}/v2/account`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    const accountId = body.data?.id;

    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new LivePixApiError('INVALID_ACCOUNT_RESPONSE', 'Resposta de conta inválida da LivePix API.', {
        httpStatus: 502,
        category: 'invalid_account_response',
      });
    }

    return accountId.trim();
  }

  async function getAccount(accessToken) {
    requireAccessToken(accessToken);
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
      (account.displayName !== undefined && account.displayName !== null && typeof account.displayName !== 'string')
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

  async function listSubscriptions(accessToken, options = {}) {
    requireAccessToken(accessToken);
    const query = validatePagination(options, {
      status: (value) => subscriptionStatuses.has(value),
      currency: (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value),
    });
    const body = await requestJson(`${apiBaseUrl}/v2/subscriptions${query}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    return validateDataArray(
      body,
      isSubscription,
      'INVALID_SUBSCRIPTIONS_RESPONSE',
      'Resposta de assinaturas inválida da LivePix API.',
    );
  }

  async function getSubscription(accessToken, subscriptionId) {
    requireAccessToken(accessToken);
    if (!isObjectId(subscriptionId)) {
      throw invalidRequestOptions();
    }

    const body = await requestJson(`${apiBaseUrl}/v2/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!isSubscription(body.data)) {
      throw invalidResponse('INVALID_SUBSCRIPTION_RESPONSE', 'Resposta de assinatura inválida da LivePix API.');
    }
    return body.data;
  }

  async function listSubscriptionTransactions(accessToken, subscriptionId, options = {}) {
    requireAccessToken(accessToken);
    if (!isObjectId(subscriptionId)) {
      throw invalidRequestOptions();
    }
    const query = validatePagination(options, {
      proof: (value) => typeof value === 'string' && /^E\d{30}$/.test(value),
    });
    const body = await requestJson(
      `${apiBaseUrl}/v2/subscriptions/${encodeURIComponent(subscriptionId)}/transactions${query}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      },
    );

    return validateDataArray(
      body,
      isSubscriptionTransaction,
      'INVALID_SUBSCRIPTION_TRANSACTIONS_RESPONSE',
      'Resposta de transações da assinatura inválida da LivePix API.',
    );
  }

  async function listSubscriptionPlans(accessToken, options = {}) {
    requireAccessToken(accessToken);
    const query = validatePagination(options);
    let httpStatus = 'unknown';
    let body;
    try {
      body = await requestJson(
        `${apiBaseUrl}/v2/subscriptions/plans${query}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        },
        (status) => {
          httpStatus = status;
        },
      );
    } catch (error) {
      if (error?.code === 'INVALID_JSON_RESPONSE') {
        logger.warn(`LivePix plans response invalid status=${httpStatus} json=invalid`);
      }
      throw error;
    }

    if (!Array.isArray(body.data) || !body.data.every(isSubscriptionPlan)) {
      logInvalidPlansResponse(httpStatus, body);
      throw invalidResponse(
        'INVALID_SUBSCRIPTION_PLANS_RESPONSE',
        'Resposta de planos de assinatura inválida da LivePix API.',
      );
    }
    return body.data;
  }

  return {
    exchangeClientCredentialsToken,
    exchangeAuthorizationCodeToken,
    getAccountId,
    getAccount,
    listSubscriptions,
    getSubscription,
    listSubscriptionTransactions,
    listSubscriptionPlans,
    getEndpointCooldown,
  };
}

const defaultService = createLivePixApiService();
defaultService.LivePixApiError = LivePixApiError;
defaultService.createLivePixApiService = createLivePixApiService;

module.exports = defaultService;
