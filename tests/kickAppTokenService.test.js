process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const { createKickAppTokenService } = require('../src/services/kickAppTokenService');

describe('kickAppTokenService', () => {
  function createService(overrides = {}) {
    let nowMs = overrides.nowMs || 1_000_000;

    const kickApiService =
      overrides.kickApiService ||
      {
        exchangeClientCredentialsToken: jest.fn().mockResolvedValue({
          accessToken: 'app-token-1',
          expiresIn: 3600,
        }),
      };

    const service = createKickAppTokenService({
      config: {
        kickClientId: 'client-id',
        kickClientSecret: 'client-secret',
        ...overrides.config,
      },
      kickApiService,
      now: () => nowMs,
      refreshSkewMs: overrides.refreshSkewMs || 60_000,
    });

    return {
      service,
      kickApiService,
      setNowMs(nextValue) {
        nowMs = nextValue;
      },
    };
  }

  test('obtém App Access Token com client credentials', async () => {
    const { service, kickApiService } = createService();

    const token = await service.getAccessToken();

    expect(token).toBe('app-token-1');
    expect(kickApiService.exchangeClientCredentialsToken).toHaveBeenCalledWith({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
  });

  test('reutiliza token em memória enquanto válido', async () => {
    const { service, kickApiService } = createService();

    const first = await service.getAccessToken();
    const second = await service.getAccessToken();

    expect(first).toBe('app-token-1');
    expect(second).toBe('app-token-1');
    expect(kickApiService.exchangeClientCredentialsToken).toHaveBeenCalledTimes(1);
  });

  test('renova token após expiração (considerando janela de renovação)', async () => {
    const kickApiService = {
      exchangeClientCredentialsToken: jest
        .fn()
        .mockResolvedValueOnce({ accessToken: 'token-old', expiresIn: 10 })
        .mockResolvedValueOnce({ accessToken: 'token-new', expiresIn: 3600 }),
    };

    const { service, setNowMs } = createService({
      nowMs: 5_000,
      refreshSkewMs: 3_000,
      kickApiService,
    });

    const first = await service.getAccessToken();
    setNowMs(12_500);
    const second = await service.getAccessToken();

    expect(first).toBe('token-old');
    expect(second).toBe('token-new');
    expect(kickApiService.exchangeClientCredentialsToken).toHaveBeenCalledTimes(2);
  });

  test('resposta de token inválida gera erro controlado', async () => {
    const kickApiService = {
      exchangeClientCredentialsToken: jest.fn().mockResolvedValue({
        accessToken: 'token-without-expiry',
        expiresIn: null,
      }),
    };

    const { service } = createService({ kickApiService });

    await expect(service.getAccessToken()).rejects.toMatchObject({
      code: 'INVALID_TOKEN_RESPONSE',
      httpStatus: 502,
    });
  });

  test('Client Secret ausente gera erro seguro com nome da variável', async () => {
    const { service, kickApiService } = createService({
      config: {
        kickClientSecret: '',
      },
    });

    await expect(service.getAccessToken()).rejects.toMatchObject({
      code: 'MISSING_CONFIG',
      missingVar: 'KICK_CLIENT_SECRET',
    });

    expect(kickApiService.exchangeClientCredentialsToken).not.toHaveBeenCalled();
  });
});
