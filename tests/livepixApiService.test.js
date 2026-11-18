const { createLivePixApiService } = require('../src/services/livepixApiService');

function makeResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name] || headers[name.toLowerCase()] || null;
      },
    },
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
  id: 'plan-basic',
  slug: 'basic',
  name: 'Plano Básico',
  description: 'Plano básico',
  amount: '100',
  currency: 'BRL',
  createdAt: '2023-01-01T10:00:00-03:00',
};

describe('livepixApiService', () => {
  test('troca authorization_code sem alterar o fluxo client_credentials', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        access_token: 'individual-access-token',
        token_type: 'Bearer',
        refresh_token: 'must-not-be-persisted',
      }),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    const redirectUri = 'https://bot.example/livepix/callback?continue=%2Fhome';
    await expect(
      service.exchangeAuthorizationCodeToken({
        clientId: 'livepix-client-id',
        clientSecret: 'client-secret',
        code: 'authorization-code',
        redirectUri,
      }),
    ).resolves.toEqual({ accessToken: 'individual-access-token' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth.livepix.gg/oauth2/token');
    expect(new URLSearchParams(options.body)).toEqual(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'livepix-client-id',
        client_secret: 'client-secret',
        code: 'authorization-code',
        redirect_uri: redirectUri,
      }),
    );
    expect(options.body).not.toContain('refresh_token');
  });

  test('rejeita espaços no redirect_uri sem normalizá-lo', async () => {
    const fetchMock = jest.fn();
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(
      service.exchangeAuthorizationCodeToken({
        clientId: 'livepix-client-id',
        clientSecret: 'client-secret',
        code: 'authorization-code',
        redirectUri: ' https://bot.example/livepix/callback',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST_OPTIONS' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('consulta somente o ID retornado por /v2/account', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: { id: 'lp-account-123' } }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.getAccountId('individual-access-token')).resolves.toBe('lp-account-123');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.livepix.gg/v2/account');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer individual-access-token');
  });

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

  test.each(['Bearer', 'BEARER', 'bEaReR'])(
    'aceita capitalização OAuth equivalente e preserva token_type (%s)',
    async (tokenType) => {
      const fetchMock = jest.fn().mockResolvedValue(
        makeResponse(200, {
          access_token: 'access-token',
          expires_in: 3600,
          token_type: tokenType,
        }),
      );
      const service = createLivePixApiService({ fetchImpl: fetchMock });

      await expect(
        service.exchangeClientCredentialsToken({
          clientId: 'client-id',
          clientSecret: 'client-secret',
        }),
      ).resolves.toMatchObject({ tokenType, expiresIn: 3600 });
    },
  );

  test.each([
    ['string numérica', '3600'],
    ['nulo', null],
    ['fracionário', 1.5],
    ['zero', 0],
    ['escopo nulo', 3600, { scope: null }],
    ['escopo com tipo incorreto', 3600, { scope: 42 }],
  ])('rejeita resposta OAuth inválida: %s', async (_label, expiresIn = 3600, extras = {}) => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        access_token: 'access-token',
        expires_in: expiresIn,
        token_type: 'bearer',
        ...extras,
      }),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(
      service.exchangeClientCredentialsToken({
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_TOKEN_RESPONSE',
      httpStatus: 502,
    });
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
      makeResponse(200, {
        access_token: 'token-without-expiry',
        token_type: 'bearer',
      }),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(
      service.exchangeClientCredentialsToken({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        scope: 'account:read',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_TOKEN_RESPONSE',
      httpStatus: 502,
    });
  });

  test('rejeita resposta inválida da conta', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: { id: 'account-123' } }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.getAccount('access-token')).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT_RESPONSE',
      httpStatus: 502,
    });
  });

  test.each([
    ['ausente', {}],
    ['nulo', { displayName: null }],
  ])('aceita displayName opcional %s e mantém a forma do resultado', async (_label, optionalField) => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        data: {
          id: 'account-123',
          username: 'livepix-user',
          ...optionalField,
        },
      }),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.getAccount('access-token')).resolves.toEqual({
      id: 'account-123',
      username: 'livepix-user',
      displayName: null,
    });
  });

  test.each([42, false, {}])('rejeita displayName com tipo incorreto: %p', async (displayName) => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        data: { id: 'account-123', username: 'livepix-user', displayName },
      }),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.getAccount('access-token')).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT_RESPONSE',
      httpStatus: 502,
    });
  });

  test('mapeia falha HTTP sem incluir corpo que possa conter credenciais', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(401, {
        message: 'client-secret-value access-token-secret',
      }),
    );
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
    const service = createLivePixApiService({
      fetchImpl: fetchMock,
      timeoutMs: 5,
    });

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
    expect(url).toBe('https://api.livepix.gg/v2/subscriptions?status=active&currency=BRL&page=2&limit=10');
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization).toBe('Bearer access-token');
  });

  test.each(['Active', 'ACTIVE', 'aCtIvE', 'Pending', 'CANCELLED'])(
    'aceita status conhecido sem diferenciar capitalização e preserva valor: %s',
    async (status) => {
      const responseSubscription = { ...subscription, status };
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(makeResponse(200, { data: [responseSubscription] }))
        .mockResolvedValueOnce(makeResponse(200, { data: responseSubscription }));
      const service = createLivePixApiService({ fetchImpl: fetchMock });

      await expect(service.listSubscriptions('access-token')).resolves.toEqual([responseSubscription]);
      await expect(service.getSubscription('access-token', subscription.id)).resolves.toEqual(responseSubscription);
    },
  );

  test.each(['paused', 'Paused', '', null, 42])(
    'rejeita status desconhecido ou de tipo incorreto: %p',
    async (status) => {
      const invalidSubscription = { ...subscription, status };
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(makeResponse(200, { data: [invalidSubscription] }))
        .mockResolvedValueOnce(makeResponse(200, { data: invalidSubscription }));
      const service = createLivePixApiService({ fetchImpl: fetchMock });

      await expect(service.listSubscriptions('access-token')).rejects.toMatchObject({
        code: 'INVALID_SUBSCRIPTIONS_RESPONSE',
      });
      await expect(service.getSubscription('access-token', subscription.id)).rejects.toMatchObject({
        code: 'INVALID_SUBSCRIPTION_RESPONSE',
      });
    },
  );

  test('aceita assinatura sem subscriber na listagem sem adicionar o campo', async () => {
    const subscriptionWithoutSubscriber = { ...subscription };
    delete subscriptionWithoutSubscriber.subscriber;
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [subscriptionWithoutSubscriber] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptions('access-token')).resolves.toEqual([subscriptionWithoutSubscriber]);
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

    await expect(service.getSubscription('access-token', subscription.id)).resolves.toEqual(subscription);
    await expect(
      service.listSubscriptionTransactions('access-token', subscription.id, {
        proof: transaction.proof,
        page: 3,
        limit: 100,
      }),
    ).resolves.toEqual([transaction]);

    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.livepix.gg/v2/subscriptions/${subscription.id}`);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://api.livepix.gg/v2/subscriptions/${subscription.id}/transactions?proof=${transaction.proof}&page=3&limit=100`,
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer access-token');
  });

  test('aceita transação no formato observado pela LivePix sem campos opcionais', async () => {
    const transaction = {
      id: 'transaction-20261118-001',
      proof: 'livepix-proof-value',
      amount: 100,
      createdAt: '2026-11-18T16:28:07-03:00',
    };
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [transaction] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptionTransactions('access-token', subscription.id)).resolves.toEqual([
      transaction,
    ]);
  });

  test.each([
    ['data ausente', {}],
    ['data não array', { data: { id: 'transaction-1' } }],
    ['item nulo', { data: [null] }],
    ['item array', { data: [[]] }],
    ['id ausente', { data: [{ proof: 'proof', amount: 100, createdAt: '2026-11-18T16:28:07Z' }] }],
    ['id vazio', { data: [{ id: '', proof: 'proof', amount: 100, createdAt: '2026-11-18T16:28:07Z' }] }],
    ['proof ausente', { data: [{ id: 'transaction-1', amount: 100, createdAt: '2026-11-18T16:28:07Z' }] }],
    ['proof com tipo incorreto', { data: [{ id: 'transaction-1', proof: 123, amount: 100, createdAt: '2026-11-18T16:28:07Z' }] }],
    ['amount inválido', { data: [{ id: 'transaction-1', proof: 'proof', amount: 1.5, createdAt: '2026-11-18T16:28:07Z' }] }],
    ['createdAt inválido', { data: [{ id: 'transaction-1', proof: 'proof', amount: 100, createdAt: 'soon' }] }],
  ])('rejeita resposta de transações inválida: %s', async (_label, body) => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, body));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptionTransactions('access-token', subscription.id)).rejects.toMatchObject({
      code: 'INVALID_SUBSCRIPTION_TRANSACTIONS_RESPONSE',
      httpStatus: 502,
    });
  });

  test.each([
    ['assinaturas', 'listSubscriptions', 'renewAt'],
    ['detalhes da assinatura', 'getSubscription', 'updatedAt'],
    ['transações', 'listSubscriptionTransactions', 'createdAt'],
    ['planos', 'listSubscriptionPlans', 'createdAt'],
  ])('rejeita data inválida em %s', async (_label, method, field) => {
    const invalidDate = '2024-02-31T12:30:00Z';
    const transaction = {
      id: subscription.id,
      proof: 'E000000000000000000000000000000',
      amount: 1000,
      createdAt: '2023-07-27T17:04:49-03:00',
    };
    const responseByMethod = {
      listSubscriptions: { data: [{ ...subscription, [field]: invalidDate }] },
      getSubscription: { data: { ...subscription, [field]: invalidDate } },
      listSubscriptionTransactions: {
        data: [{ ...transaction, [field]: invalidDate }],
      },
      listSubscriptionPlans: {
        data: [{ ...subscriptionPlan, [field]: invalidDate }],
      },
    };
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, responseByMethod[method]));
    const service = createLivePixApiService({ fetchImpl: fetchMock });
    const invocation = {
      listSubscriptions: () => service.listSubscriptions('access-token'),
      getSubscription: () => service.getSubscription('access-token', subscription.id),
      listSubscriptionTransactions: () => service.listSubscriptionTransactions('access-token', subscription.id),
      listSubscriptionPlans: () => service.listSubscriptionPlans('access-token'),
    }[method]();

    await expect(invocation).rejects.toMatchObject({
      code: expect.stringMatching(/^INVALID_/),
      httpStatus: 502,
    });
  });

  test('aceita data de ano bissexto com fuso documentado no formato ISO', async () => {
    const leapDateSubscription = {
      ...subscription,
      renewAt: '2024-02-29T23:59:59.123-03:00',
    };
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [leapDateSubscription] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptions('access-token')).resolves.toEqual([leapDateSubscription]);
  });

  test('aceita detalhes de assinatura sem subscriber sem adicionar o campo', async () => {
    const subscriptionWithoutSubscriber = { ...subscription };
    delete subscriptionWithoutSubscriber.subscriber;
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: subscriptionWithoutSubscriber }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.getSubscription('access-token', subscription.id)).resolves.toEqual(
      subscriptionWithoutSubscriber,
    );
  });

  test.each([
    ['null', null],
    ['número', 123],
    ['string vazia', ''],
    ['string acima do limite', 'x'.repeat(73)],
  ])('rejeita subscriber inválido (%s) em listagem e detalhe', async (_label, subscriber) => {
    const invalidSubscription = { ...subscription, subscriber };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(200, { data: [invalidSubscription] }))
      .mockResolvedValueOnce(makeResponse(200, { data: invalidSubscription }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptions('access-token')).rejects.toMatchObject({
      code: 'INVALID_SUBSCRIPTIONS_RESPONSE',
      httpStatus: 502,
    });
    await expect(service.getSubscription('access-token', subscription.id)).rejects.toMatchObject({
      code: 'INVALID_SUBSCRIPTION_RESPONSE',
      httpStatus: 502,
    });
  });

  test('consulta planos com paginação e escopo autorizado pelo endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [subscriptionPlan] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptionPlans('access-token', { page: 4, limit: 100 })).resolves.toEqual([
      subscriptionPlan,
    ]);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.livepix.gg/v2/subscriptions/plans?page=4&limit=100');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer access-token');
  });

  test('aceita lista vazia de planos', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptionPlans('access-token')).resolves.toEqual([]);
  });

  test.each(['100', 100])('aceita plano no formato observado e preserva amount (%s)', async (amount) => {
    const plan = { ...subscriptionPlan, amount };
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [plan] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptionPlans('access-token')).resolves.toEqual([plan]);
  });

  test.each([
    ['zero como number', 0],
    ['inteiro positivo como number', 42],
    ['string numérica', '42'],
    ['string acima de Number.MAX_SAFE_INTEGER', '9007199254740992'],
    ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
  ])('aceita amount válido: %s e preserva tipo e conteúdo', async (_label, amount) => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [{ ...subscriptionPlan, amount }] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    const [plan] = await service.listSubscriptionPlans('access-token');

    expect(plan.amount).toBe(amount);
    expect(typeof plan.amount).toBe(typeof amount);
  });

  test.each([
    ['number acima de Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
    ['number negativo', -1],
    ['number fracionário', 1.5],
    ['string vazia', ''],
    ['string com espaços', ' '],
    ['string com espaço inicial', ' 1'],
    ['string com espaço final', '1 '],
    ['string com sinal positivo', '+1'],
    ['string com sinal negativo', '-1'],
    ['string com ponto decimal', '1.0'],
    ['string com notação científica', '1e3'],
  ])('rejeita amount inválido: %s', async (_label, amount) => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [{ ...subscriptionPlan, amount }] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptionPlans('access-token')).rejects.toMatchObject({
      code: 'INVALID_SUBSCRIPTION_PLANS_RESPONSE',
      httpStatus: 502,
    });
  });

  test.each([
    ['data ausente', {}],
    ['data nulo', { data: null }],
    ['data como objeto', { data: { plan: subscriptionPlan } }],
    ['data como string', { data: 'plans' }],
    ['item sem id obrigatório', { data: [{ ...subscriptionPlan, id: undefined }] }],
    ['item sem descrição obrigatória', { data: [{ ...subscriptionPlan, description: undefined }] }],
    ['descrição nula', { data: [{ ...subscriptionPlan, description: null }] }],
    ['id vazio', { data: [{ ...subscriptionPlan, id: '' }] }],
  ])('rejeita estrutura incompatível com o schema de planos: %s', async (_label, body) => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, body));
    const service = createLivePixApiService({
      fetchImpl: fetchMock,
      logger: { warn: jest.fn() },
    });

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
      'LivePix plans response invalid status=200 root_fields=data:array data_type=array item_count=1 item_fields=id:string,slug:string,name:string,description:null,amount:string,currency:string,createdAt:string',
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
    expect(logger.warn).toHaveBeenCalledWith('LivePix plans response invalid status=200 json=invalid');
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
      service.listSubscriptionTransactions('token', subscription.id, {
        proof: 'invalid',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST_OPTIONS',
      httpStatus: 400,
    });
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
      listSubscriptionTransactions: () => service.listSubscriptionTransactions('token', subscription.id),
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

    await expect(service.listSubscriptions('token')).rejects.toMatchObject({
      code,
      httpStatus: status,
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token');
  });

  test('preserva headers do rate limit e ativa cooldown até o reset Unix válido', async () => {
    const now = 2_000_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const headers = {
      'X-RateLimit-Limit': '60',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(now / 1000 + 30),
    };
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(429, { ignored: 'sensitive' }, headers));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    try {
      await expect(service.listSubscriptions('private-token')).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        rateLimitHeaders: headers,
        cooldownUntil: now + 30_000,
      });
      expect(service.getEndpointCooldown('/v2/subscriptions')).toBe(now + 30_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('HTTP 429 sem headers não inventa cooldown nem faz retry', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(429, { private: 'body' }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptions('token')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      rateLimitHeaders: {
        'X-RateLimit-Limit': null,
        'X-RateLimit-Remaining': null,
        'X-RateLimit-Reset': null,
      },
      cooldownUntil: null,
    });
    expect(service.getEndpointCooldown('/v2/subscriptions')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('header de reset inválido é preservado sem ativar cooldown', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(
        429,
        {},
        {
          'X-RateLimit-Limit': '60',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': 'not-a-timestamp',
        },
      ),
    );
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptions('token')).rejects.toMatchObject({
      rateLimitHeaders: {
        'X-RateLimit-Reset': 'not-a-timestamp',
      },
      cooldownUntil: null,
    });
    expect(service.getEndpointCooldown('/v2/subscriptions')).toBeNull();
  });

  test('cooldown de assinaturas não bloqueia o endpoint de planos', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 60;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(429, {}, { 'X-RateLimit-Reset': String(resetAt) }))
      .mockResolvedValueOnce(makeResponse(200, { data: [] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    await expect(service.listSubscriptions('token')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await expect(service.listSubscriptionPlans('token')).resolves.toEqual([]);
    await expect(service.listSubscriptions('token')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('chamadas simultâneas à mesma rota aguardam e respeitam o cooldown recebido', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 60;
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(429, {}, { 'X-RateLimit-Reset': String(resetAt) }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    const results = await Promise.allSettled([
      service.listSubscriptions('token'),
      service.listSubscriptions('token', { page: 2 }),
    ]);

    expect(results.map(({ reason }) => reason?.code)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('libera o endpoint após o horário do reset', async () => {
    let now = 2_000_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(makeResponse(429, {}, { 'X-RateLimit-Reset': String(now / 1000 + 2) }))
      .mockResolvedValueOnce(makeResponse(200, { data: [] }));
    const service = createLivePixApiService({ fetchImpl: fetchMock });

    try {
      await expect(service.listSubscriptions('token')).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
      now += 2_001;
      await expect(service.listSubscriptions('token')).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(service.getEndpointCooldown('/v2/subscriptions')).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [429, 'RATE_LIMITED'],
  ])('preserva o mapeamento HTTP %i em consulta de planos', async (status, code) => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(status, { message: 'private response body' }));
    const logger = { warn: jest.fn() };
    const service = createLivePixApiService({ fetchImpl: fetchMock, logger });

    await expect(service.listSubscriptionPlans('access-token')).rejects.toMatchObject({
      code,
      httpStatus: status,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('mapeia 404 da assinatura sem expor o corpo da resposta', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(404, { message: 'private subscriber details' }));
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
    const timeoutService = createLivePixApiService({
      fetchImpl: timeoutFetch,
      timeoutMs: 5,
    });
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
