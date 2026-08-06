process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const crypto = require('crypto');
const { createKickAuthService } = require('../src/services/kickAuthService');

describe('kickAuthService', () => {
  function createService(overrides = {}) {
    let nowMs = overrides.nowMs || 1_000_000;

    const service = createKickAuthService({
      config: {
        kickEnabled: true,
        kickClientId: 'kick-client-id',
        kickClientSecret: 'kick-client-secret',
        kickRedirectUri: 'http://localhost:3000/kick/callback',
      },
      kickAccountsRepository:
        overrides.kickAccountsRepository || {
          upsert: jest.fn((account) => ({
            discord_id: account.discordId,
            kick_user_id: account.kickUserId,
            kick_username: account.kickUsername,
            linked_at_ms: account.updatedAtMs,
            updated_at_ms: account.updatedAtMs,
          })),
        },
      kickApiService:
        overrides.kickApiService || {
          exchangeAuthorizationCode: jest.fn().mockResolvedValue({ accessToken: 'token-value' }),
          getAuthorizedUser: jest.fn().mockResolvedValue({ kickUserId: '999', kickUsername: 'kick-user' }),
        },
      now: () => nowMs,
      ttlMs: 10 * 60 * 1000,
      randomBytes: overrides.randomBytes,
    });

    return {
      service,
      setNowMs(nextMs) {
        nowMs = nextMs;
      },
    };
  }

  test('gera states diferentes entre solicitações', () => {
    const { service } = createService();
    const first = service.generateState();
    const second = service.generateState();

    expect(first).not.toBe(second);
  });

  test('gera code_challenge S256 válido', () => {
    const { service } = createService();
    const verifier = 'abcABC123-._~verifier';
    const challenge = service.generateCodeChallenge(verifier);
    const expected = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    expect(challenge).toBe(expected);
  });

  test('constrói URL de autorização com parâmetros oficiais e sem secret', () => {
    const { service } = createService();

    const url = service.buildAuthorizationUrl({
      clientId: 'kick-client-id',
      redirectUri: 'http://localhost:3000/kick/callback',
      scope: 'user:read',
      codeChallenge: 'challenge-value',
      state: 'state-value',
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://id.kick.com/oauth/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('kick-client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:3000/kick/callback');
    expect(parsed.searchParams.get('scope')).toBe('user:read');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('state')).toBe('state-value');
    expect(url).not.toContain('client_secret');
  });

  test('state válido pode ser consumido uma única vez', () => {
    const { service } = createService();

    const attempt = service.createAuthorizationAttempt('discord-123');
    const consumed = service.consumeValidState(attempt.state);

    expect(consumed.discordId).toBe('discord-123');

    expect(() => service.consumeValidState(attempt.state)).toThrow(/State já utilizado/);
  });

  test('state inexistente retorna erro controlado', () => {
    const { service } = createService();

    expect(() => service.consumeValidState('state-inexistente')).toThrow(/State inválido/);
  });

  test('state expirado retorna erro controlado', () => {
    const { service, setNowMs } = createService({ nowMs: 5_000_000 });

    const attempt = service.createAuthorizationAttempt('discord-expirado');
    setNowMs(5_000_000 + 10 * 60 * 1000 + 1);

    expect(() => service.consumeValidState(attempt.state)).toThrow(/State expirado/);
  });

  test('troca code, consulta usuário e persiste vínculo sem tokens', async () => {
    const repository = {
      upsert: jest.fn((account) => ({
        discord_id: account.discordId,
        kick_user_id: account.kickUserId,
        kick_username: account.kickUsername,
        linked_at_ms: account.updatedAtMs,
        updated_at_ms: account.updatedAtMs,
      })),
    };
    const kickApiService = {
      exchangeAuthorizationCode: jest.fn().mockResolvedValue({ accessToken: 'token-value', refreshToken: 'refresh-value' }),
      getAuthorizedUser: jest.fn().mockResolvedValue({ kickUserId: '700', kickUsername: 'kick700' }),
    };

    const { service } = createService({ kickAccountsRepository: repository, kickApiService });
    const attempt = service.createAuthorizationAttempt('discord-700');

    const result = await service.completeOAuthCallback({ code: 'auth-code-700', state: attempt.state });

    expect(result).toEqual({
      discordId: 'discord-700',
      kickUserId: '700',
      kickUsername: 'kick700',
    });

    expect(kickApiService.exchangeAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(kickApiService.getAuthorizedUser).toHaveBeenCalledTimes(1);
    expect(repository.upsert).toHaveBeenCalledTimes(1);

    const upsertPayload = repository.upsert.mock.calls[0][0];
    expect(upsertPayload.discordId).toBe('discord-700');
    expect(upsertPayload.kickUserId).toBe('700');
    expect(upsertPayload.kickUsername).toBe('kick700');
    expect(upsertPayload.accessToken).toBeUndefined();
    expect(upsertPayload.refreshToken).toBeUndefined();
  });

  test('propaga conflito de kick_user_id', async () => {
    const conflictError = new Error('Conflito de vínculo');
    conflictError.code = 'KICK_ACCOUNT_CONFLICT';

    const repository = {
      upsert: jest.fn(() => {
        throw conflictError;
      }),
    };

    const { service } = createService({ kickAccountsRepository: repository });
    const attempt = service.createAuthorizationAttempt('discord-conflict');

    await expect(
      service.completeOAuthCallback({ code: 'auth-code-conflict', state: attempt.state }),
    ).rejects.toMatchObject({ code: 'KICK_ACCOUNT_CONFLICT' });
  });

  test('callback sem code retorna erro', async () => {
    const { service } = createService();

    await expect(service.completeOAuthCallback({ state: 'x' })).rejects.toMatchObject({ code: 'MISSING_CODE' });
  });

  test('callback sem state retorna erro', async () => {
    const { service } = createService();

    await expect(service.completeOAuthCallback({ code: 'x' })).rejects.toMatchObject({ code: 'MISSING_STATE' });
  });
});
