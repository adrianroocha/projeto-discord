const { MessageFlags } = require('discord.js');

jest.mock('../src/config', () => ({
  guildId: 'guild-1',
}));

jest.mock('../src/services/kickStatusDiagnosticsService', () => ({
  readLocalKickStatus: jest.fn(),
  formatKickStatusContent: jest.fn(),
}));

const kickStatusDiagnosticsService = require('../src/services/kickStatusDiagnosticsService');
const button = require('../src/buttons/kickLinkStatus');

describe('kick_link_status button', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('responde com deferReply ephemeral e editReply para o próprio autor', async () => {
    kickStatusDiagnosticsService.readLocalKickStatus.mockResolvedValue({ discordId: 'discord-1' });
    kickStatusDiagnosticsService.formatKickStatusContent.mockReturnValue('diagnóstico seguro');

    const interaction = {
      inGuild: () => true,
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      user: { id: 'discord-1' },
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await button.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(kickStatusDiagnosticsService.readLocalKickStatus).toHaveBeenCalledWith({
      discordId: 'discord-1',
      guild: interaction.guild,
    });
    expect(kickStatusDiagnosticsService.formatKickStatusContent).toHaveBeenCalledWith(
      { discordId: 'discord-1' },
      {
        includeUserLine: false,
        includeKickId: false,
        includeLinkGuidance: true,
      },
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'diagnóstico seguro',
        allowedMentions: { parse: [] },
      }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test('não aceita uso fora do servidor', async () => {
    const interaction = {
      inGuild: () => false,
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await button.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Este botão só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(kickStatusDiagnosticsService.readLocalKickStatus).not.toHaveBeenCalled();
  });

  test('bloqueia guild diferente da configurada', async () => {
    const interaction = {
      inGuild: () => true,
      guildId: 'guild-2',
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await button.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Este botão só está disponível no servidor configurado para esta integração.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(kickStatusDiagnosticsService.readLocalKickStatus).not.toHaveBeenCalled();
  });

  test('falha de leitura retorna código seguro sem vazar mensagem interna', async () => {
    kickStatusDiagnosticsService.readLocalKickStatus.mockRejectedValue(
      new Error('secret token=abc stack=trace'),
    );

    const interaction = {
      inGuild: () => true,
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      user: { id: 'discord-2' },
      deferred: true,
      replied: false,
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await button.execute(interaction);

    const payload = interaction.editReply.mock.calls[0][0];
    expect(payload.content).toContain('KICK_LINK_STATUS_READ_FAILED');
    expect(payload.content).not.toContain('token=abc');
    expect(payload.content).not.toContain('stack=trace');
  });

  test('cliques concorrentes de usuários distintos executam leituras independentes', async () => {
    kickStatusDiagnosticsService.readLocalKickStatus.mockImplementation(async ({ discordId }) => ({ discordId }));
    kickStatusDiagnosticsService.formatKickStatusContent.mockImplementation((status) => `ok-${status.discordId}`);

    const first = {
      inGuild: () => true,
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      user: { id: 'discord-A' },
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    };

    const second = {
      inGuild: () => true,
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      user: { id: 'discord-B' },
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await Promise.all([button.execute(first), button.execute(second)]);

    expect(kickStatusDiagnosticsService.readLocalKickStatus).toHaveBeenCalledWith({
      discordId: 'discord-A',
      guild: first.guild,
    });
    expect(kickStatusDiagnosticsService.readLocalKickStatus).toHaveBeenCalledWith({
      discordId: 'discord-B',
      guild: second.guild,
    });
    expect(first.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: 'ok-discord-A' }));
    expect(second.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: 'ok-discord-B' }));
  });
});
