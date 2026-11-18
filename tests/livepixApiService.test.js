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
});
