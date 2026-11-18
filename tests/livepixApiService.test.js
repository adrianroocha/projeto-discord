const { createLivePixApiService } = require('../src/services/livepixApiService');

function makeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

const subscription = {
  id: '61021c7bdabe5e001225b65b',
  subscriber: 'subscriber-name',
  months: 3,
  currency: 'BRL',
  amount: 1000,
  recurrence: 'monthly',
  status: 'active',
  renewAt: '2024-01-01T00:00:00-03:00',
  updatedAt: '2023-12-01T15:30:00-03:00',
  createdAt: '2023-01-01T10:00:00-03:00',
};

const subscriptionPlan = {
  id: '61021c7bdabe5e001225b65b',
  slug: 'basic',
  name: 'Plano Básico',
  description: 'Plano básico',
  amount: 10,
  currency: 'BRL',
  createdAt: '2023-01-01T10:00:00-03:00',
};

describe('livepixApiService', () => {
  test('solicita token client_credentials no endpoint oficial e envia escopo', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        access_token: 'access-token-secret',
        expires_in: 3600,
        scope: 'account:read',
        token_type: 'bearer',
      }),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    const token = await service.exchangeClientCredentialsToken({
      clientId: 'livepix-client-id',
      clientSecret: 'client-secret-value',
      scope: 'account:read',
    });

    expect(token).toEqual({
      accessToken: 'access-token-secret',
      tokenType: 'bearer',
      scope: 'account:read',
      expiresIn: 3600,
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth.livepix.gg/oauth2/token');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(options.body)).toEqual(
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'livepix-client-id',
        client_secret: 'client-secret-value',
        scope: 'account:read',
      }),
    );
  });

  test('consulta /v2/account com token e retorna apenas campos necessários', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        data: {
          id: 'account-123',
          email: 'private@example.test',
          username: 'livepix-user',
          displayName: 'LivePix User',
          avatar: 'https://example.test/avatar.png',
        },
      }),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    const account = await service.getAccount('access-token-secret');

    expect(account).toEqual({
      id: 'account-123',
      username: 'livepix-user',
      displayName: 'LivePix User',
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.livepix.gg/v2/account');
    expect(options.headers.Authorization).toBe('Bearer access-token-secret');
    expect(JSON.stringify(account)).not.toContain('private@example.test');
  });

  test('rejeita resposta de token inválida', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, { access_token: 'token-without-expiry', token_type: 'bearer' }),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(
      service.exchangeClientCredentialsToken({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        scope: 'account:read',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN_RESPONSE', httpStatus: 502 });
  });

  test('rejeita resposta inválida da conta', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: { id: 'account-123' } }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.getAccount('access-token')).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT_RESPONSE',
      httpStatus: 502,
    });
  });

  test('mapeia falha HTTP sem incluir corpo que possa conter credenciais', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(makeResponse(401, { message: 'client-secret-value access-token-secret' }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(
      service.exchangeClientCredentialsToken({
        clientId: 'client-id',
        clientSecret: 'client-secret-value',
      }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'A LivePix recusou a autenticação.',
    });
  });

  test('mapeia timeout da requisição', async () => {
    const fetchMock = jest.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock, timeoutMs: 5 });

    await expect(
      service.exchangeClientCredentialsToken({
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', httpStatus: 504 });
  });

  test('consulta assinaturas com Bearer e apenas parâmetros documentados', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [subscription] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(
      service.listSubscriptions('access-token', {
        status: 'active',
        currency: 'BRL',
        page: 2,
        limit: 10,
      }),
    ).resolves.toEqual([subscription]);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.livepix.gg/v2/subscriptions?status=active&currency=BRL&page=2&limit=10',
    );
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization).toBe('Bearer access-token');
  });

  test('consulta detalhes de assinatura e transações com parâmetros validados', async () => {
    const transaction = {
      id: '61021c7bdabe5e001225b65b',
      proof: 'E000000000000000000000000000000',
      amount: 1000,
      createdAt: '2023-07-27T17:04:49-03:00',
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(200, { data: subscription }))
      .mockResolvedValueOnce(makeResponse(200, { data: [transaction] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.getSubscription('access-token', subscription.id)).resolves.toEqual(
      subscription,
    );
    await expect(
      service.listSubscriptionTransactions('access-token', subscription.id, {
        proof: transaction.proof,
        page: 3,
        limit: 100,
      }),
    ).resolves.toEqual([transaction]);

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.livepix.gg/v2/subscriptions/${subscription.id}`,
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://api.livepix.gg/v2/subscriptions/${subscription.id}/transactions?proof=${transaction.proof}&page=3&limit=100`,
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer access-token');
  });

  test('consulta planos com paginação e escopo autorizado pelo endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [subscriptionPlan] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptionPlans('access-token', { page: 4, limit: 100 })).resolves
      .toEqual([subscriptionPlan]);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.livepix.gg/v2/subscriptions/plans?page=4&limit=100',
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer access-token');
  });

  test('aceita lista vazia de planos', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptionPlans('access-token')).resolves.toEqual([]);
  });

  test.each([
    ['data ausente', {}],
    ['data nulo', { data: null }],
    ['data como objeto', { data: { plan: subscriptionPlan } }],
    ['data como string', { data: 'plans' }],
    ['item sem id obrigatório', { data: [{ ...subscriptionPlan, id: undefined }] }],
    ['item sem descrição obrigatória', { data: [{ ...subscriptionPlan, description: undefined }] }],
    ['descrição nula', { data: [{ ...subscriptionPlan, description: null }] }],
  ])('rejeita estrutura incompatível com o schema de planos: %s', async (_label, body) => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, body));
    const service = createLivePixApiService({ fetchImpl: fetchMock, logger: { warn: jest.fn() } });

    await expect(service.listSubscriptionPlans('access-token')).rejects.toMatchObject({
      code: 'INVALID_SUBSCRIPTION_PLANS_RESPONSE',
      httpStatus: 502,
    });
  });

  test('registra somente metadados estruturais seguros para resposta inválida de planos', async () => {
    const logger = { warn: jest.fn() };
    const privatePlanName = 'sensitive plan name';
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        data: [{ ...subscriptionPlan, name: privatePlanName, description: null }],
      }),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock, logger });

    await expect(service.listSubscriptionPlans('access-token')).rejects.toMatchObject({
      code: 'INVALID_SUBSCRIPTION_PLANS_RESPONSE',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'LivePix plans response invalid status=200 root_fields=data:array data_type=array item_count=1 item_fields=id:string,slug:string,name:string,description:null,amount:number,currency:string,createdAt:string',
    );
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain(privatePlanName);
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain('access-token');
  });

  test('mapeia JSON inválido em consulta de planos sem registrar o corpo', async () => {
    const logger = { warn: jest.fn() };
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, 'private response body'));
    const service = createLivePixApiService({ fetchImpl: fetchMock, logger });

    await expect(service.listSubscriptionPlans('access-token')).rejects.toMatchObject({
      code: 'INVALID_JSON_RESPONSE',
      httpStatus: 502,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'LivePix plans response invalid status=200 json=invalid',
    );
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain('private response body');
  });

  test('rejeita IDs e parâmetros inválidos sem enviar requisição', async () => {
    const fetchMock = jest.fn();
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.getSubscription('token', 'not-an-object-id')).rejects.toMatchObject({
      code: 'INVALID_REQUEST_OPTIONS',
      httpStatus: 400,
    });
    await expect(
      service.listSubscriptionTransactions('token', subscription.id, { proof: 'invalid' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST_OPTIONS', httpStatus: 400 });
    await expect(service.listSubscriptions('token', { page: 0 })).rejects.toMatchObject({
      code: 'INVALID_REQUEST_OPTIONS',
      httpStatus: 400,
    });
    await expect(service.listSubscriptionPlans('token', { unexpected: 'value' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST_OPTIONS',
      httpStatus: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ['lista de assinaturas', 'listSubscriptions', { data: [{ id: 'invalid' }] }],
    ['detalhes da assinatura', 'getSubscription', { data: { id: 'invalid' } }],
    ['transações', 'listSubscriptionTransactions', { data: [{ id: 'invalid' }] }],
    ['planos', 'listSubscriptionPlans', { data: [{ id: 'invalid' }] }],
    ['formato de data inválido', 'listSubscriptions', { data: [{ ...subscription, renewAt: 'soon' }] }],
    ['data ausente', 'listSubscriptionPlans', { data: null }],
  ])('rejeita resposta malformada de %s', async (_label, method, responseBody) => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, responseBody));
    const service = createLivePixApiService({ fetchImpl: fetchMock });
    const invocation = {
      listSubscriptions: () => service.listSubscriptions('token'),
      getSubscription: () => service.getSubscription('token', subscription.id),
      listSubscriptionTransactions: () =>
        service.listSubscriptionTransactions('token', subscription.id),
      listSubscriptionPlans: () => service.listSubscriptionPlans('token'),
    }[method]();

    await expect(invocation).rejects.toMatchObject({
      code: expect.stringMatching(/^INVALID_/),
      httpStatus: 502,
    });
  });

  test.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [429, 'RATE_LIMITED'],
  ])('mapeia HTTP %i em consulta de assinatura', async (status, code) => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(status, { message: 'private data' }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptions('token')).rejects.toMatchObject({ code, httpStatus: status });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token');
  });

  test.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [429, 'RATE_LIMITED'],
  ])('preserva o mapeamento HTTP %i em consulta de planos', async (status, code) => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(makeResponse(status, { message: 'private response body' }));
    const logger = { warn: jest.fn() };
    const service = createLivePixApiService({ fetchImpl: fetchMock, logger });

    await expect(service.listSubscriptionPlans('access-token')).rejects.toMatchObject({
      code,
      httpStatus: status,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('mapeia 404 da assinatura sem expor o corpo da resposta', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(makeResponse(404, { message: 'private subscriber details' }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.getSubscription('token', subscription.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'O recurso solicitado não foi encontrado na LivePix.',
      httpStatus: 404,
    });
  });

  test('mapeia timeout e falha de rede nas consultas', async () => {
    const timeoutFetch = jest.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const timeoutService = createLivePixApiService({ fetchImpl: timeoutFetch, timeoutMs: 5 });
    await expect(timeoutService.listSubscriptions('token')).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      httpStatus: 504,
    });

    const networkService = createLivePixApiService({
      fetchImpl: jest.fn().mockRejectedValue(new Error('network details')),
    });
    await expect(networkService.listSubscriptionPlans('token')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      httpStatus: 503,
    });
  });
});
