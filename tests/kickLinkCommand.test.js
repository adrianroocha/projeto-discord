const { MessageFlags } = require('discord.js');
jest.mock('../src/services/kickLinkStartService', () => ({
  createStartPayload: jest.fn(),
  mapKickLinkError: jest.fn(() => 'erro-controlado'),
}));

const kickLinkStartService = require('../src/services/kickLinkStartService');
const command = require('../src/commands/kickLink');

describe('/kick-link command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reutiliza serviço compartilhado e responde ephemeral', async () => {
    kickLinkStartService.createStartPayload.mockReturnValue({
      content: 'ok',
      components: [],
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-1' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(kickLinkStartService.createStartPayload).toHaveBeenCalledWith('discord-1');
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  test('retorna payload de já vinculado sem duplicar lógica no comando', async () => {
    kickLinkStartService.createStartPayload.mockReturnValue({
      content: 'Sua conta já está vinculada: kick-username (Kick ID 999). Use /kick-status para consultar o estado atual.',
      components: [],
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-2' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
      }),
    );
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
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(kickLinkStartService.createStartPayload).not.toHaveBeenCalled();
  });

  test('erro do serviço compartilhado é mapeado para resposta segura', async () => {
    kickLinkStartService.createStartPayload.mockImplementation(() => {
      const error = new Error('falhou');
      error.code = 'KICK_OAUTH_DISABLED';
      throw error;
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-3' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(kickLinkStartService.mapKickLinkError).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'erro-controlado',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });
});
