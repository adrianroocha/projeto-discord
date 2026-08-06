jest.mock('../src/config', () => ({
  kickEnabled: true,
}));

jest.mock('../src/database/kickAccountsRepository', () => ({
  findByDiscordId: jest.fn(),
}));

jest.mock('../src/services/kickAuthService', () => ({
  createAuthorizationAttempt: jest.fn(),
}));

const kickAccountsRepository = require('../src/database/kickAccountsRepository');
const kickAuthService = require('../src/services/kickAuthService');
const command = require('../src/commands/kickLink');

describe('/kick-link command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('responde ephemeral com botão de vínculo quando não há vínculo prévio', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue(null);
    kickAuthService.createAuthorizationAttempt.mockReturnValue({
      authorizationUrl:
        'https://id.kick.com/oauth/authorize?response_type=code&client_id=abc&scope=user%3Aread&state=state-1',
      expiresAtMs: Date.now() + 10 * 60 * 1000,
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-1' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.ephemeral).toBe(true);
    expect(payload.components).toHaveLength(1);

    const button = payload.components[0].toJSON().components[0];
    expect(button.style).toBe(5);
    expect(button.url).toContain('https://id.kick.com/oauth/authorize');
    expect(button.url).toContain('scope=user%3Aread');
    expect(button.url).not.toContain('client_secret');
  });

  test('informa usuário já vinculado', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_username: 'kick-username',
      kick_user_id: '999',
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-2' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
      }),
    );

    expect(kickAuthService.createAuthorizationAttempt).not.toHaveBeenCalled();
  });

  test('bloqueia uso em DM e responde ephemeral', async () => {
    const interaction = {
      inGuild: () => false,
      user: { id: 'discord-dm' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
      }),
    );
    expect(kickAccountsRepository.findByDiscordId).not.toHaveBeenCalled();
  });
});
