jest.mock('../src/database/kickAccountsRepository', () => ({
  findByDiscordId: jest.fn(),
}));

const kickAccountsRepository = require('../src/database/kickAccountsRepository');
const command = require('../src/commands/kickStatus');

describe('/kick-status command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('usuário sem vínculo recebe orientação amigável', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue(null);

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-1' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Nenhuma conta Kick está vinculada. Use /kick-link para vincular sua conta.',
        ephemeral: true,
      }),
    );
  });

  test('usuário com vínculo recebe username e kick id corretos', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue({
      discord_id: 'discord-2',
      kick_user_id: '75942843',
      kick_username: 'adrianroocha',
      linked_at_ms: 1_720_000_000_123,
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-2' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain('Conta Kick: adrianroocha');
    expect(payload.content).toContain('Kick ID: 75942843');
  });

  test('converte linked_at_ms para timestamp Discord em segundos', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_user_id: '100',
      kick_username: 'user100',
      linked_at_ms: 1_725_111_222_999,
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-3' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('<t:1725111222:F>');
  });

  test('não afirma status de subscriber', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_user_id: '101',
      kick_username: 'user101',
      linked_at_ms: 1_700_000_000_000,
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-4' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Status da assinatura: ainda não sincronizado');
    expect(payload.content).not.toContain('é SUB');
    expect(payload.content).not.toContain('não é SUB');
  });

  test('responde sempre ephemeral', async () => {
    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_user_id: '102',
      kick_username: 'user102',
      linked_at_ms: 1_700_000_000_000,
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-5' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  test('recusa em DM', async () => {
    const interaction = {
      inGuild: () => false,
      user: { id: 'discord-dm' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(kickAccountsRepository.findByDiscordId).not.toHaveBeenCalled();
  });
});
