process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const { createLivePixLinkStartService } = require('../src/services/livepixLinkStartService');

describe('livepixLinkStartService', () => {
  test('não inicia outro OAuth quando Discord já possui vínculo LivePix', () => {
    const repository = { findByDiscordId: jest.fn().mockReturnValue({ livepix_account_id: 'private-id' }) };
    const authService = { createAuthorizationAttempt: jest.fn(), isEnabled: jest.fn().mockReturnValue(true) };
    const service = createLivePixLinkStartService({
      config: {},
      livepixAccountsRepository: repository,
      livepixLinkAuthService: authService,
    });

    expect(service.createStartPayload('discord-1')).toEqual({
      content: 'Sua conta LivePix já está vinculada. Consulte o painel para verificar ou desvincular.',
      components: [],
    });
    expect(authService.createAuthorizationAttempt).not.toHaveBeenCalled();
  });

  test('cria link somente após gerar tentativa OAuth', () => {
    const repository = { findByDiscordId: jest.fn().mockReturnValue(null) };
    const authService = {
      createAuthorizationAttempt: jest.fn().mockReturnValue({
        authorizationUrl: 'https://oauth.livepix.gg/oauth2/auth?state=secure',
        expiresAtMs: 600_000,
      }),
      isEnabled: jest.fn().mockReturnValue(true),
    };
    const service = createLivePixLinkStartService({
      config: {},
      livepixAccountsRepository: repository,
      livepixLinkAuthService: authService,
    });

    const payload = service.createStartPayload('discord-2');

    expect(authService.createAuthorizationAttempt).toHaveBeenCalledWith('discord-2');
    expect(payload.authorizationUrl).toContain('oauth.livepix.gg/oauth2/auth');
    expect(payload.components[0].toJSON().components[0].label).toBe('Autorizar na LivePix');
  });
});
