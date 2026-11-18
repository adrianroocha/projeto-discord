process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const { createLivePixAuthService } = require('../src/services/livepixAuthService');

describe('livepixAuthService', () => {
  function createService(overrides = {}) {
    let nowMs = overrides.nowMs || 1_000_000;
    const livepixApiService =
      overrides.livepixApiService ||
      {
        exchangeClientCredentialsToken: jest.fn().mockResolvedValue({
          accessToken: 'access-token-1',
          expiresIn: 3600,
        }),
        getAccount: jest.fn().mockResolvedValue({
          id: 'account-1',
          username: 'livepix-user',
          displayName: 'LivePix User',
        }),
      };
    const service = createLivePixAuthService({
      config: {
        livepixClientId: 'livepix-client-id',
        livepixClientSecret: 'livepix-client-secret',
        livepixOauthScopes: ['account:read'],
        ...overrides.config,
      },
      livepixApiService,
      now: () => nowMs,
      refreshSkewMs: overrides.refreshSkewMs || 60_000,
    });

    return {
      service,
      livepixApiService,
      setNowMs(nextValue) {
        nowMs = nextValue;
      },
    };
  }

  test('obtém token com escopo de conta configurado', async () => {
    const { service, livepixApiService } = createService();

    await expect(service.getAccessToken()).resolves.toBe('access-token-1');
    expect(livepixApiService.exchangeClientCredentialsToken).toHaveBeenCalledWith({
      clientId: 'livepix-client-id',
      clientSecret: 'livepix-client-secret',
      scope: 'account:read',
    });
  });

  test('envia múltiplos escopos OAuth separados por espaços', async () => {
    const { service, livepixApiService } = createService({
      config: {
        livepixOauthScopes: [
          'account:read',
          'subscriptions:read',
          'subscription-plans:read',
        ],
      },
    });

    await service.getAccessToken();

    expect(livepixApiService.exchangeClientCredentialsToken).toHaveBeenCalledWith({
      clientId: 'livepix-client-id',
      clientSecret: 'livepix-client-secret',
      scope: 'account:read subscriptions:read subscription-plans:read',
    });
  });

  test('reutiliza token em memória enquanto válido', async () => {
    const { service, livepixApiService } = createService();

    await service.getAccessToken();
    await service.getAccessToken();

    expect(livepixApiService.exchangeClientCredentialsToken).toHaveBeenCalledTimes(1);
  });

  test('obtém novo token quando entra na janela de expiração', async () => {
    const livepixApiService = {
      exchangeClientCredentialsToken: jest
        .fn()
        .mockResolvedValueOnce({ accessToken: 'old-token', expiresIn: 3600 })
        .mockResolvedValueOnce({ accessToken: 'new-token', expiresIn: 3600 }),
      getAccount: jest.fn(),
    };
    const { service, setNowMs } = createService({ livepixApiService, nowMs: 100_000 });

    await expect(service.getAccessToken()).resolves.toBe('old-token');
    setNowMs(3_640_000);
    await expect(service.getAccessToken()).resolves.toBe('new-token');
    expect(livepixApiService.exchangeClientCredentialsToken).toHaveBeenCalledTimes(2);
  });

  test('reutiliza token de curta duração sem renovação antecipada excessiva', async () => {
    const livepixApiService = {
      exchangeClientCredentialsToken: jest
        .fn()
        .mockResolvedValue({ accessToken: 'short-lived-token', expiresIn: 10 }),
      getAccount: jest.fn(),
    };
    const { service, setNowMs } = createService({ livepixApiService, nowMs: 1_000 });

    await service.getAccessToken();
    setNowMs(2_000);
    await expect(service.getAccessToken()).resolves.toBe('short-lived-token');

    expect(livepixApiService.exchangeClientCredentialsToken).toHaveBeenCalledTimes(1);
  });

  test('compartilha solicitação de token entre chamadas simultâneas', async () => {
    let resolveToken;
    const livepixApiService = {
      exchangeClientCredentialsToken: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveToken = resolve;
          }),
      ),
      getAccount: jest.fn(),
    };
    const { service } = createService({ livepixApiService });

    const first = service.getAccessToken();
    const second = service.getAccessToken();
    await Promise.resolve();
    expect(livepixApiService.exchangeClientCredentialsToken).toHaveBeenCalledTimes(1);

    resolveToken({ accessToken: 'shared-token', expiresIn: 3600 });
    await expect(Promise.all([first, second])).resolves.toEqual(['shared-token', 'shared-token']);
  });

  test('falha de autenticação propaga erro e permite nova tentativa', async () => {
    const livepixApiService = {
      exchangeClientCredentialsToken: jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('secret must not leak'), { code: 'UNAUTHORIZED' }))
        .mockResolvedValueOnce({ accessToken: 'recovered-token', expiresIn: 3600 }),
      getAccount: jest.fn(),
    };
    const { service } = createService({ livepixApiService });

    await expect(service.getAccessToken()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(service.getAccessToken()).resolves.toBe('recovered-token');
    expect(livepixApiService.exchangeClientCredentialsToken).toHaveBeenCalledTimes(2);
  });

  test('resposta de token inválida não é armazenada', async () => {
    const livepixApiService = {
      exchangeClientCredentialsToken: jest.fn().mockResolvedValue({
        accessToken: 'invalid-token',
        expiresIn: 0,
      }),
      getAccount: jest.fn(),
    };
    const { service } = createService({ livepixApiService });

    await expect(service.getAccessToken()).rejects.toMatchObject({
      code: 'INVALID_TOKEN_RESPONSE',
      httpStatus: 502,
    });
  });

  test('consulta a conta autenticada sem compartilhar token com o resultado', async () => {
    const { service, livepixApiService } = createService();

    const account = await service.getAuthenticatedAccount();

    expect(livepixApiService.getAccount).toHaveBeenCalledWith('access-token-1');
    expect(account).toEqual({
      id: 'account-1',
      username: 'livepix-user',
      displayName: 'LivePix User',
    });
    expect(JSON.stringify(account)).not.toContain('access-token-1');
  });

  test('encaminha consultas de assinatura usando o token em cache', async () => {
    const livepixApiService = {
      exchangeClientCredentialsToken: jest.fn().mockResolvedValue({
        accessToken: 'access-token-1',
        expiresIn: 3600,
      }),
      listSubscriptions: jest.fn().mockResolvedValue([]),
      getSubscription: jest.fn().mockResolvedValue({ id: 'subscription-1' }),
      listSubscriptionTransactions: jest.fn().mockResolvedValue([]),
      listSubscriptionPlans: jest.fn().mockResolvedValue([]),
    };
    const { service } = createService({ livepixApiService });
    const options = { page: 2, limit: 10 };

    await service.listSubscriptions(options);
    await service.getSubscription('subscription-1');
    await service.listSubscriptionTransactions('subscription-1', options);
    await service.listSubscriptionPlans(options);

    expect(livepixApiService.listSubscriptions).toHaveBeenCalledWith('access-token-1', options);
    expect(livepixApiService.getSubscription).toHaveBeenCalledWith(
      'access-token-1',
      'subscription-1',
    );
    expect(livepixApiService.listSubscriptionTransactions).toHaveBeenCalledWith(
      'access-token-1',
      'subscription-1',
      options,
    );
    expect(livepixApiService.listSubscriptionPlans).toHaveBeenCalledWith(
      'access-token-1',
      options,
    );
    expect(livepixApiService.exchangeClientCredentialsToken).toHaveBeenCalledTimes(1);
  });

  test('401 em consulta invalida o token e deixa a nova autenticação para a próxima chamada', async () => {
    const livepixApiService = {
      exchangeClientCredentialsToken: jest
        .fn()
        .mockResolvedValueOnce({ accessToken: 'expired-token', expiresIn: 3600 })
        .mockResolvedValueOnce({ accessToken: 'refreshed-token', expiresIn: 3600 }),
      listSubscriptions: jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { code: 'UNAUTHORIZED' }))
        .mockResolvedValueOnce([]),
    };
    const { service } = createService({ livepixApiService });

    await expect(service.listSubscriptions({ page: 1 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(livepixApiService.listSubscriptions).toHaveBeenCalledTimes(1);
    await expect(service.listSubscriptions({ page: 1 })).resolves.toEqual([]);

    expect(livepixApiService.exchangeClientCredentialsToken).toHaveBeenCalledTimes(2);
    expect(livepixApiService.listSubscriptions).toHaveBeenNthCalledWith(
      1,
      'expired-token',
      { page: 1 },
    );
    expect(livepixApiService.listSubscriptions).toHaveBeenNthCalledWith(
      2,
      'refreshed-token',
      { page: 1 },
    );
  });

  test('invalidar token em resposta 401 força nova autenticação na próxima consulta', async () => {
    const livepixApiService = {
      exchangeClientCredentialsToken: jest
        .fn()
        .mockResolvedValueOnce({ accessToken: 'expired-token', expiresIn: 3600 })
        .mockResolvedValueOnce({ accessToken: 'refreshed-token', expiresIn: 3600 }),
      getAccount: jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { code: 'UNAUTHORIZED' }))
        .mockResolvedValueOnce({ id: 'account-1', username: 'livepix-user', displayName: null }),
    };
    const { service } = createService({ livepixApiService });

    await expect(service.getAuthenticatedAccount()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await service.getAuthenticatedAccount();

    expect(livepixApiService.exchangeClientCredentialsToken).toHaveBeenCalledTimes(2);
    expect(livepixApiService.getAccount).toHaveBeenNthCalledWith(2, 'refreshed-token');
  });

  test('configuração ausente informa somente o nome da variável', async () => {
    const { service, livepixApiService } = createService({
      config: { livepixClientSecret: '' },
    });

    await expect(service.getAccessToken()).rejects.toMatchObject({
      code: 'MISSING_CONFIG',
      missingVar: 'LIVEPIX_CLIENT_SECRET',
    });
    expect(livepixApiService.exchangeClientCredentialsToken).not.toHaveBeenCalled();
  });
});
