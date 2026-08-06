const { createKickApiService } = require('../src/services/kickApiService');

function makeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

describe('kickApiService', () => {
  test('troca code por token com payload x-www-form-urlencoded', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        access_token: 'token-abc',
        refresh_token: 'refresh-abc',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'user:read',
      }),
    );

    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });
    const result = await service.exchangeAuthorizationCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost:3000/kick/callback',
      codeVerifier: 'verifier-123',
      code: 'code-123',
    });

    expect(result.accessToken).toBe('token-abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const sentBody = new URLSearchParams(options.body);
    expect(sentBody.get('grant_type')).toBe('authorization_code');
    expect(sentBody.get('client_id')).toBe('client-id');
    expect(sentBody.get('client_secret')).toBe('client-secret');
    expect(sentBody.get('redirect_uri')).toBe('http://localhost:3000/kick/callback');
    expect(sentBody.get('code_verifier')).toBe('verifier-123');
    expect(sentBody.get('code')).toBe('code-123');
  });

  test('retorna erro controlado para 400 no token endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(400, { error: 'invalid_request' }));
    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });

    await expect(
      service.exchangeAuthorizationCode({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost:3000/kick/callback',
        codeVerifier: 'verifier-123',
        code: 'bad-code',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', httpStatus: 400 });
  });

  test('retorna erro controlado para 401 no endpoint /users', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(401, { message: 'unauthorized' }));
    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });

    await expect(service.getAuthorizedUser('token-unauthorized')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      httpStatus: 401,
    });
  });

  test('retorna erro controlado para 429', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(429, { message: 'rate limit' }));
    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });

    await expect(service.getAuthorizedUser('token-rate')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
    });
  });

  test('retorna erro controlado para falha 5xx', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(503, { message: 'unavailable' }));
    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });

    await expect(service.getAuthorizedUser('token-5xx')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      httpStatus: 502,
    });
  });

  test('retorna erro de timeout', async () => {
    const fetchMock = jest.fn().mockImplementation(() => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1 });

    await expect(service.getAuthorizedUser('token-timeout')).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      httpStatus: 504,
    });
  });

  test('retorna erro para resposta inválida de usuário', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { data: [{ user_id: 777 }] }));
    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });

    await expect(service.getAuthorizedUser('token-invalid-user')).rejects.toMatchObject({
      code: 'INVALID_USER_RESPONSE',
      httpStatus: 502,
    });
  });

  test('lê usuário autorizado usando schema oficial (data[] com user_id e name)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        data: [
          {
            user_id: 12345,
            name: 'kick_user_name',
            profile_picture: 'https://example.com/pic.png',
          },
        ],
        message: 'OK',
      }),
    );

    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });
    const user = await service.getAuthorizedUser('token-ok');

    expect(user).toEqual({ kickUserId: '12345', kickUsername: 'kick_user_name' });
  });

  test('troca client credentials por app token', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        access_token: 'app-token-xyz',
        token_type: 'Bearer',
        expires_in: 7200,
      }),
    );

    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });
    const result = await service.exchangeClientCredentialsToken({
      clientId: 'kick-client-id',
      clientSecret: 'kick-client-secret',
    });

    expect(result).toEqual(
      expect.objectContaining({
        accessToken: 'app-token-xyz',
        expiresIn: 7200,
      }),
    );

    const [, options] = fetchMock.mock.calls[0];
    const sentBody = new URLSearchParams(options.body);
    expect(sentBody.get('grant_type')).toBe('client_credentials');
    expect(sentBody.get('client_id')).toBe('kick-client-id');
    expect(sentBody.get('client_secret')).toBe('kick-client-secret');
  });

  test('GET subscriptions com wrapper data e campo event string', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        message: 'OK',
        data: [
          {
            id: 'sub-get-1',
            broadcaster_user_id: 75942843,
            method: 'webhook',
            event: 'channel.subscription.new',
            version: 1,
          },
        ],
      }),
    );

    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });
    const result = await service.listEventSubscriptions({
      accessToken: 'app-token-abc',
      broadcasterUserId: 75942843,
    });

    expect(result.subscriptions).toEqual([
      {
        name: 'channel.subscription.new',
        version: 1,
        broadcasterUserId: '75942843',
        subscriptionId: 'sub-get-1',
        method: 'webhook',
      },
    ]);
    expect(result.status).toBe(200);
    expect(result.message).toBe('OK');
    expect(result.diagnostics).toEqual([
      {
        name: 'channel.subscription.new',
        version: 1,
        subscriptionIdPresent: true,
        error: null,
      },
    ]);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/events/subscriptions?broadcaster_user_id=75942843');
    expect(options.headers.Authorization).toBe('Bearer app-token-abc');
  });

  test('POST subscriptions com wrapper data e subscription_id válido', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        message: 'OK',
        data: [
          {
            name: 'channel.subscription.gifts',
            version: 1,
            subscription_id: 'sub-post-1',
          },
        ],
      }),
    );

    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });
    const result = await service.createEventSubscriptions({
      accessToken: 'app-token-created',
      broadcasterUserId: 75942843,
      events: [{ name: 'channel.subscription.gifts', version: 1 }],
    });

    expect(result.results).toEqual([
      {
        name: 'channel.subscription.gifts',
        version: 1,
        subscriptionId: 'sub-post-1',
        error: null,
        confirmed: true,
      },
    ]);
    expect(result.status).toBe(200);
    expect(result.message).toBe('OK');
    expect(result.diagnostics).toEqual([
      {
        name: 'channel.subscription.gifts',
        version: 1,
        subscriptionIdPresent: true,
        error: null,
      },
    ]);

    const [, options] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(options.body);
    expect(sentBody).toEqual({
      broadcaster_user_id: 75942843,
      method: 'webhook',
      events: [{ name: 'channel.subscription.gifts', version: 1 }],
    });
  });

  test('POST preserva erro individual retornado pela Kick', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        message: 'OK',
        data: [
          {
            name: 'channel.subscription.new',
            version: '1',
            error: 'SUBSCRIPTION_LIMIT_REACHED',
          },
        ],
      }),
    );

    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });
    const result = await service.createEventSubscriptions({
      accessToken: 'app-token-created',
      broadcasterUserId: 111111,
      events: [{ name: 'channel.subscription.new', version: 1 }],
    });

    expect(result.results).toEqual([
      {
        name: 'channel.subscription.new',
        version: 1,
        subscriptionId: null,
        error: 'SUBSCRIPTION_LIMIT_REACHED',
        confirmed: false,
      },
    ]);
  });

  test('POST com error vazio mantém item como confirmado quando subscription_id existe', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      makeResponse(200, {
        data: [
          {
            name: 'channel.subscription.renewal',
            version: '1',
            subscription_id: 'sub-post-renewal',
            error: '   ',
          },
        ],
      }),
    );

    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });
    const result = await service.createEventSubscriptions({
      accessToken: 'app-token-created',
      broadcasterUserId: 222222,
      events: [{ name: 'channel.subscription.renewal', version: 1 }],
    });

    expect(result.results[0]).toEqual({
      name: 'channel.subscription.renewal',
      version: 1,
      subscriptionId: 'sub-post-renewal',
      error: null,
      confirmed: true,
    });
  });

  test('resposta inesperada em subscriptions retorna erro controlado', async () => {
    const fetchMock = jest.fn().mockResolvedValue(makeResponse(200, { message: 'OK', data: {} }));
    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });

    await expect(
      service.createEventSubscriptions({
        accessToken: 'app-token-created',
        broadcasterUserId: 333333,
        events: [{ name: 'channel.subscription.gifts', version: 1 }],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_SUBSCRIPTIONS_RESPONSE',
      httpStatus: 502,
    });
  });

  test('propaga message do erro de nível superior para diagnóstico seguro', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(makeResponse(400, { message: 'Invalid broadcaster_user_id' }));
    const service = createKickApiService({ fetchImpl: fetchMock, timeoutMs: 1000 });

    await expect(
      service.createEventSubscriptions({
        accessToken: 'app-token-created',
        broadcasterUserId: 0,
        events: [{ name: 'channel.subscription.gifts', version: 1 }],
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      upstreamMessage: 'Invalid broadcaster_user_id',
    });
  });
});
