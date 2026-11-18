process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const { createLivePixLinkAuthService } = require('../src/services/livepixLinkAuthService');

const config = {
  livepixClientId: 'livepix-client-id',
  livepixClientSecret: 'livepix-client-secret',
  livepixRedirectUri: 'https://bot.example/livepix/callback',
  livepixLinkOauthScopes: ['account:read'],
  livepixLinkEnabled: true,
};

function createService(options = {}) {
  const livepixApiService = {
    exchangeAuthorizationCodeToken: jest.fn().mockResolvedValue({ accessToken: 'individual-token' }),
    getAccountId: jest.fn().mockResolvedValue('livepix-account-1'),
    ...options.livepixApiService,
  };
  const repository = {
    createLink: jest.fn().mockImplementation((input) => ({
      discord_id: input.discordId,
      livepix_account_id: input.livepixAccountId,
    })),
    ...options.livepixAccountsRepository,
  };
  let nowMs = options.nowMs ?? 1_000_000;
  let randomSequence = 0;
  const service = createLivePixLinkAuthService({
    config: options.config || config,
    livepixApiService,
    livepixAccountsRepository: repository,
    now: () => nowMs,
    randomBytes: () => {
      const bytes = Buffer.alloc(32, 7);
      bytes.writeUInt32BE(++randomSequence, 28);
      return bytes;
    },
  });
  return {
    service,
    livepixApiService,
    repository,
    advanceTime: (milliseconds) => {
      nowMs += milliseconds;
    },
  };
}

describe('livepixLinkAuthService', () => {
  test('gera URL oficial com state criptográfico associado ao Discord por 10 minutos', () => {
    const { service } = createService();
    const attempt = service.createAuthorizationAttempt('discord-user-1');
    const url = new URL(attempt.authorizationUrl);

    expect(url.origin + url.pathname).toBe('https://oauth.livepix.gg/oauth2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(config.livepixClientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.livepixRedirectUri);
    expect(url.searchParams.get('scope')).toBe('account:read');
    expect(url.searchParams.get('state')).toBe(attempt.state);
    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.ttlMs).toBe(10 * 60 * 1000);
    expect(service.consumeValidState(attempt.state)).toMatchObject({ discordId: 'discord-user-1' });
  });

  test('rejeita state inválido, expirado e reutilizado', () => {
    const { service, advanceTime } = createService();
    expect(() => service.consumeValidState('invalid')).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID' }),
    );

    const expired = service.createAuthorizationAttempt('discord-expired');
    advanceTime(10 * 60 * 1000);
    expect(() => service.consumeValidState(expired.state)).toThrow(
      expect.objectContaining({ code: 'STATE_EXPIRED' }),
    );

    const reused = service.createAuthorizationAttempt('discord-reused');
    service.consumeValidState(reused.state);
    expect(() => service.consumeValidState(reused.state)).toThrow(
      expect.objectContaining({ code: 'STATE_REUSED' }),
    );
  });

  test('troca código simulado, consulta somente ID e persiste apenas metadados do vínculo', async () => {
    const { service, livepixApiService, repository } = createService();
    const attempt = service.createAuthorizationAttempt('discord-linked');

    await expect(service.completeOAuthCallback({ code: 'valid-code', state: attempt.state })).resolves.toEqual({
      discordId: 'discord-linked',
      livepixAccountId: 'livepix-account-1',
    });
    expect(livepixApiService.exchangeAuthorizationCodeToken).toHaveBeenCalledWith({
      clientId: config.livepixClientId,
      clientSecret: config.livepixClientSecret,
      redirectUri: config.livepixRedirectUri,
      code: 'valid-code',
    });
    expect(livepixApiService.getAccountId).toHaveBeenCalledWith('individual-token');
    expect(repository.createLink).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'discord-linked',
        livepixAccountId: 'livepix-account-1',
      }),
    );
    expect(JSON.stringify(repository.createLink.mock.calls[0][0])).not.toContain('individual-token');
  });

  test('usa exatamente o mesmo redirect_uri na autorização e na troca do código', async () => {
    const redirectUri = 'https://bot.example/livepix/callback?continue=%2Fhome';
    const { service, livepixApiService } = createService({
      config: { ...config, livepixRedirectUri: redirectUri },
    });
    const attempt = service.createAuthorizationAttempt('discord-exact-redirect');

    expect(new URL(attempt.authorizationUrl).searchParams.get('redirect_uri')).toBe(redirectUri);
    await service.completeOAuthCallback({ code: 'valid-code', state: attempt.state });
    expect(livepixApiService.exchangeAuthorizationCodeToken).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri }),
    );
  });

  test('cancelamento consome state e não troca o código', async () => {
    const { service, livepixApiService } = createService();
    const attempt = service.createAuthorizationAttempt('discord-cancelled');

    await expect(
      service.completeOAuthCallback({ state: attempt.state, error: 'access_denied' }),
    ).rejects.toMatchObject({ code: 'OAUTH_CANCELLED' });
    expect(livepixApiService.exchangeAuthorizationCodeToken).not.toHaveBeenCalled();
    expect(() => service.consumeValidState(attempt.state)).toThrow(
      expect.objectContaining({ code: 'STATE_REUSED' }),
    );
  });

  test('erro do provedor também consome state sem expor descrição recebida', async () => {
    const { service, livepixApiService } = createService();
    const attempt = service.createAuthorizationAttempt('discord-provider-error');

    await expect(
      service.completeOAuthCallback({
        state: attempt.state,
        error: 'server_error',
        error_description: 'private-provider-details',
      }),
    ).rejects.toMatchObject({
      code: 'OAUTH_PROVIDER_ERROR',
      message: expect.not.stringContaining('private-provider-details'),
    });
    expect(livepixApiService.exchangeAuthorizationCodeToken).not.toHaveBeenCalled();
  });

  test('código inválido simulado impede consulta de conta e consome state', async () => {
    const { service, livepixApiService } = createService({
      livepixApiService: {
        exchangeAuthorizationCodeToken: jest.fn().mockRejectedValue({
          code: 'BAD_REQUEST',
          httpStatus: 400,
        }),
      },
    });
    const attempt = service.createAuthorizationAttempt('discord-invalid-code');

    await expect(service.completeOAuthCallback({ code: 'invalid-code', state: attempt.state })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(livepixApiService.getAccountId).not.toHaveBeenCalled();
    expect(() => service.consumeValidState(attempt.state)).toThrow(
      expect.objectContaining({ code: 'STATE_REUSED' }),
    );
  });

  test('não sobrescreve vínculos em conflito', async () => {
    const conflict = Object.assign(new Error('Este usuário do Discord ou esta conta LivePix já possui um vínculo.'), {
      code: 'LIVEPIX_ACCOUNT_CONFLICT',
      reason: 'account_already_linked',
    });
    const { service, repository } = createService({
      livepixAccountsRepository: { createLink: jest.fn(() => { throw conflict; }) },
    });
    const attempt = service.createAuthorizationAttempt('discord-conflict');

    await expect(service.completeOAuthCallback({ code: 'valid-code', state: attempt.state })).rejects.toMatchObject({
      code: 'LIVEPIX_ACCOUNT_CONFLICT',
    });
    expect(repository.createLink).toHaveBeenCalledTimes(1);
  });
});
