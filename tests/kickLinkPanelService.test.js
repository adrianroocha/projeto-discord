process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const { createKickLinkPanelService } = require('../src/services/kickLinkPanelService');

function makePermissions(hasAll) {
  return {
    has: jest.fn(() => hasAll),
  };
}

function makeTextChannel(overrides = {}) {
  const messages = {
    fetch: jest.fn().mockResolvedValue({ size: 0, find: () => null, last: () => null }),
  };

  return {
    guildId: 'guild-1',
    type: 0,
    isTextBased: () => true,
    permissionsFor: jest.fn().mockReturnValue(makePermissions(true)),
    messages,
    send: jest.fn().mockResolvedValue({ id: 'msg-1' }),
    ...overrides,
  };
}

function makeClient(channel) {
  const client = {
    user: { id: 'bot-1' },
    channels: {
      fetch: jest.fn().mockResolvedValue(channel),
    },
  };

  if (channel) {
    channel.client = client;
  }

  return client;
}

describe('kickLinkPanelService', () => {
  test('variável ausente desativa painel sem erro fatal', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const service = createKickLinkPanelService({
      config: { kickLinkChannelId: null, guildId: 'guild-1' },
      logger,
    });

    const result = await service.initPanel(makeClient(null));
    expect(result.enabled).toBe(false);
    expect(logger.info).toHaveBeenCalledWith('Painel Kick Link desativado: KICK_LINK_CHANNEL_ID ausente.');
  });

  test('canal inexistente', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const service = createKickLinkPanelService({
      config: { kickLinkChannelId: 'missing', guildId: 'guild-1' },
      logger,
    });

    const client = {
      user: { id: 'bot-1' },
      channels: {
        fetch: jest.fn().mockRejectedValue(new Error('not found')),
      },
    };

    const result = await service.upsertPanel(client);
    expect(result.enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('Painel Kick Link não inicializado: canal inexistente.');
  });

  test('canal de outro guild', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const service = createKickLinkPanelService({
      config: { kickLinkChannelId: 'channel-1', guildId: 'guild-1' },
      logger,
    });

    const channel = makeTextChannel({ guildId: 'guild-2' });
    const result = await service.upsertPanel(makeClient(channel));
    expect(result.enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('Painel Kick Link não inicializado: canal pertence a outro servidor.');
  });

  test('tipo inválido', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const service = createKickLinkPanelService({
      config: { kickLinkChannelId: 'channel-1', guildId: 'guild-1' },
      logger,
    });

    const channel = makeTextChannel({ isTextBased: () => false });
    const result = await service.upsertPanel(makeClient(channel));
    expect(result.enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('Painel Kick Link não inicializado: canal não é texto de servidor.');
  });

  test('falta de permissão', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const service = createKickLinkPanelService({
      config: { kickLinkChannelId: 'channel-1', guildId: 'guild-1' },
      logger,
    });

    const channel = makeTextChannel({ permissionsFor: jest.fn().mockReturnValue(makePermissions(false)) });
    const result = await service.upsertPanel(makeClient(channel));
    expect(result.enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('Painel Kick Link não inicializado: permissões insuficientes no canal.');
  });

  test('criação do painel com botão único Vincular conta Kick', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const service = createKickLinkPanelService({
      config: { kickLinkChannelId: 'channel-1', guildId: 'guild-1' },
      logger,
    });

    const channel = makeTextChannel();
    const client = makeClient(channel);

    const result = await service.upsertPanel(client);
    expect(result.enabled).toBe(true);
    expect(result.created).toBe(true);
    expect(client.kickLinkPanelMessageId).toBe('msg-1');

    const payload = channel.send.mock.calls[0][0];
    expect(payload.content).toContain('Vincule sua conta Kick');

    const components = payload.components[0].toJSON().components;
    expect(components).toHaveLength(1);
    expect(components[0].custom_id).toBe('kick-link-start');
    expect(components[0].label).toBe('Vincular conta Kick');
    expect(payload.content).not.toContain('desvincular');
  });

  test('atualização do painel existente sem duplicar', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const service = createKickLinkPanelService({
      config: { kickLinkChannelId: 'channel-1', guildId: 'guild-1' },
      logger,
    });

    const existingMessage = {
      id: 'msg-existing',
      author: { id: 'bot-1' },
      content: '## Vincule sua conta Kick',
      edit: jest.fn().mockResolvedValue(undefined),
    };

    const collection = {
      size: 1,
      find: (fn) => (fn(existingMessage) ? existingMessage : null),
      last: () => existingMessage,
    };

    const channel = makeTextChannel({
      messages: {
        fetch: jest
          .fn()
          .mockRejectedValueOnce(new Error('not found by id'))
          .mockResolvedValueOnce(collection),
      },
      send: jest.fn().mockResolvedValue({ id: 'msg-new' }),
    });

    const client = makeClient(channel);
    client.kickLinkPanelMessageId = 'old-id';

    const result = await service.upsertPanel(client);
    expect(result.enabled).toBe(true);
    expect(result.created).toBe(false);
    expect(client.kickLinkPanelMessageId).toBe('msg-existing');
    expect(existingMessage.edit).toHaveBeenCalledTimes(1);
    expect(channel.send).not.toHaveBeenCalled();
  });

  test('não duplica após reiniciar quando mensagem já é conhecida', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const service = createKickLinkPanelService({
      config: { kickLinkChannelId: 'channel-1', guildId: 'guild-1' },
      logger,
    });

    const existingMessage = {
      id: 'msg-known',
      author: { id: 'bot-1' },
      edit: jest.fn().mockResolvedValue(undefined),
    };

    const channel = makeTextChannel({
      messages: {
        fetch: jest.fn().mockResolvedValue(existingMessage),
      },
      send: jest.fn(),
    });

    const client = makeClient(channel);
    client.kickLinkPanelMessageId = 'msg-known';

    const result = await service.upsertPanel(client);
    expect(result.enabled).toBe(true);
    expect(result.created).toBe(false);
    expect(existingMessage.edit).toHaveBeenCalledTimes(1);
    expect(channel.send).not.toHaveBeenCalled();
  });

  test('initPanel roda uma vez por cliente', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const service = createKickLinkPanelService({
      config: { kickLinkChannelId: null, guildId: 'guild-1' },
      logger,
    });

    const client = makeClient(null);
    const first = await service.initPanel(client);
    const second = await service.initPanel(client);

    expect(first.enabled).toBe(false);
    expect(second.skipped).toBe(true);
  });
});
