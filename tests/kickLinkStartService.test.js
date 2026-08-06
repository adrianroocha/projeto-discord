process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const { createKickAuthService } = require('../src/services/kickAuthService');
const { createKickLinkStartService } = require('../src/services/kickLinkStartService');

describe('kickLinkStartService', () => {
  function createService(overrides = {}) {
    const authService =
      overrides.kickAuthService ||
      createKickAuthService({
        config: {
          kickEnabled: true,
          kickClientId: 'kick-client-id',
          kickClientSecret: 'kick-client-secret',
          kickRedirectUri: 'http://localhost:3000/kick/callback',
        },
      });

    return createKickLinkStartService({
      config: {
        kickEnabled: true,
        ...(overrides.config || {}),
      },
      kickAuthService: authService,
      kickAccountsRepository:
        overrides.kickAccountsRepository || {
          findByDiscordId: jest.fn().mockReturnValue(null),
        },
    });
  }

  test('usuário sem vínculo recebe URL OAuth individual com state e PKCE (S256)', () => {
    const service = createService();

    const first = service.createStartPayload('discord-1');
    const second = service.createStartPayload('discord-2');

    expect(first.authorizationUrl).toContain('https://id.kick.com/oauth/authorize');
    expect(second.authorizationUrl).toContain('https://id.kick.com/oauth/authorize');
    expect(first.authorizationUrl).not.toBe(second.authorizationUrl);

    const firstParsed = new URL(first.authorizationUrl);
    const secondParsed = new URL(second.authorizationUrl);

    expect(firstParsed.searchParams.get('scope')).toBe('user:read');
    expect(firstParsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(firstParsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(firstParsed.searchParams.get('state')).toBeTruthy();
    expect(secondParsed.searchParams.get('state')).toBeTruthy();
    expect(firstParsed.searchParams.get('state')).not.toBe(secondParsed.searchParams.get('state'));

    expect(first.ttlMs).toBe(10 * 60 * 1000);
  });

  test('usuário já vinculado recebe orientação para /kick-status', () => {
    const service = createService({
      kickAccountsRepository: {
        findByDiscordId: jest.fn().mockReturnValue({
          kick_username: 'kick-user',
          kick_user_id: '77',
        }),
      },
    });

    const payload = service.createStartPayload('discord-3');
    expect(payload.content).toContain('kick-user');
    expect(payload.content).toContain('/kick-status');
    expect(payload.components).toEqual([]);
  });

  test('integração desativada retorna mensagem segura', () => {
    const service = createService({ config: { kickEnabled: false } });
    const payload = service.createStartPayload('discord-4');

    expect(payload.content).toContain('Integração com Kick está desativada');
    expect(payload.components).toEqual([]);
  });
});
