process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const { createLivePixLinkPanelService } = require('../src/services/livepixLinkPanelService');

describe('livepixLinkPanelService', () => {
  test('painel LivePix contém ações de vínculo e consulta, sem botão de desvinculação', () => {
    const service = createLivePixLinkPanelService({ config: { livepixLinkChannelId: 'channel-1' } });
    const components = service.buildPanelActionRow().toJSON().components;

    expect(service.buildPanelContent()).toContain('conta LivePix');
    expect(components.map((component) => component.custom_id)).toEqual([
      'livepix-link-start',
      'livepix-link-status',
    ]);
    expect(components[0].label).toBe('Vincular conta LivePix');
  });

  test('painel pode não inicializar sem mexer no estado identificado do painel Kick', async () => {
    const service = createLivePixLinkPanelService({
      config: { livepixLinkChannelId: null, guildId: 'guild-1' },
      logger: { info: jest.fn(), warn: jest.fn() },
    });
    const client = {
      user: { id: 'bot-1' },
      kickLinkPanelMessageId: 'kick-message-id',
      channels: { fetch: jest.fn() },
    };

    await service.initPanel(client);

    expect(client.kickLinkPanelMessageId).toBe('kick-message-id');
    expect(client.livepixLinkPanelInitialized).toBe(true);
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });
});
