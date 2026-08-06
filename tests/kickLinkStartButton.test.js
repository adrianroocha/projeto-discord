jest.mock('../src/config', () => ({
  guildId: 'guild-1',
}));

jest.mock('../src/services/kickLinkStartService', () => ({
  createStartPayload: jest.fn(),
  mapKickLinkError: jest.fn(() => 'erro-controlado'),
}));

const kickLinkStartService = require('../src/services/kickLinkStartService');
const button = require('../src/buttons/kickLinkStart');

describe('kick-link-start button', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('usuário sem vínculo recebe botão de autorização em resposta ephemeral', async () => {
    kickLinkStartService.createStartPayload.mockReturnValue({
      content: 'Clique para autorizar',
      components: [{ toJSON: () => ({ components: [] }) }],
    });

    const interaction = {
      inGuild: () => true,
      guildId: 'guild-1',
      user: { id: 'discord-1' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await button.execute(interaction);

    expect(kickLinkStartService.createStartPayload).toHaveBeenCalledWith('discord-1');
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: 'Clique para autorizar',
      }),
    );
  });

  test('usuário já vinculado recebe orientação para /kick-status', async () => {
    kickLinkStartService.createStartPayload.mockReturnValue({
      content: 'Sua conta já está vinculada: nick (Kick ID 1). Use /kick-status para consultar o estado atual.',
      components: [],
    });

    const interaction = {
      inGuild: () => true,
      guildId: 'guild-1',
      user: { id: 'discord-2' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await button.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('/kick-status'),
        ephemeral: true,
      }),
    );
  });

  test('guild incorreto é bloqueado', async () => {
    const interaction = {
      inGuild: () => true,
      guildId: 'guild-2',
      user: { id: 'discord-3' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await button.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
      }),
    );
    expect(kickLinkStartService.createStartPayload).not.toHaveBeenCalled();
  });

  test('erros são mapeados em resposta segura', async () => {
    kickLinkStartService.createStartPayload.mockImplementation(() => {
      throw new Error('falha');
    });

    const interaction = {
      inGuild: () => true,
      guildId: 'guild-1',
      user: { id: 'discord-4' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await button.execute(interaction);

    expect(kickLinkStartService.mapKickLinkError).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'erro-controlado',
        ephemeral: true,
      }),
    );
  });
});
