process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';
process.env.QUEUE_PANEL_CHANNEL_ID = process.env.QUEUE_PANEL_CHANNEL_ID || 'panel-channel';

const { EventEmitter } = require('events');
const { Events } = require('discord.js');
const config = require('../src/config');
const { createTestContext } = require('./helpers/testDatabase');

let context;
let queueMessageService;

function createMockClient(userId = 'bot-id') {
  const client = new EventEmitter();
  client.user = { id: userId };
  client.queuePanelMessageId = 'old-msg';
  return client;
}

function createMockChannel(client = {}, channelId = 'panel-channel') {
  const permissionOverwrites = {
    cache: [
      { id: 'everyone-role', allow: ['ViewChannel'], deny: ['SendMessages'] },
      { id: 'staff-role', allow: ['ReadMessageHistory'], deny: [] },
      { id: 'member-1', allow: ['ViewChannel'], deny: ['AddReactions'] },
    ],
    edit: jest.fn(),
    set: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  };

  return {
    id: channelId,
    client,
    isTextBased: () => true,
    permissionOverwrites,
    send: jest.fn().mockResolvedValue({ id: 'new-msg', edit: jest.fn().mockResolvedValue(undefined) }),
    messages: {
      fetch: jest.fn().mockImplementation(async (arg) => {
        if (arg && typeof arg === 'object' && arg.limit === 100) {
          return new Map();
        }
        return null;
      }),
    },
  };
}

describe('queue panel', () => {
  beforeAll(async () => {
    config.queuePanelChannelId = 'panel-channel';
    context = await createTestContext({ nodeEnv: 'test' });
    queueMessageService = require('../src/services/queueMessageService');
  });

  afterAll(async () => {
    await context.cleanup();
  });

  test('mostra estado vazio e aviso de fila aberta', () => {
    const content = queueMessageService.buildPanelContent([], [], { isQueueOpen: true });

    expect(content).toContain('# 🎮 Sistema de Fila');
    expect(content).toContain('⏳ Após entrar na fila, é necessário aguardar 2 minutos antes de poder sair.');
    expect(content).toContain('Nenhum jogador aguardando.');
    expect(content).toContain('Nenhum lobby em formação.');
    expect(content).toContain('Nenhum lobby ativa.');
  });

  test('mostra aviso de fila fechada e sub na formatação atual', () => {
    const content = queueMessageService.buildPanelContent(
      [
        {
          lobbyNumber: 7,
          status: 'forming',
          players: [
            { username: 'Bot-Fubinha', displayName: 'Bot-Fubinha', isSubscriber: true },
            { username: 'Jogador Teste 01', displayName: 'Jogador Teste 01', isSubscriber: false },
          ],
        },
        {
          lobbyNumber: 8,
          status: 'in_game',
          players: [
            { username: 'Jogador Ativo', displayName: 'Jogador Ativo', isSubscriber: false },
          ],
        },
      ],
      [
        { username: 'Aguardando 1', display_name: 'Aguardando 1', is_subscriber: 0 },
      ],
      { isQueueOpen: false },
    );

    expect(content).toContain('🔒 Fila fechada no momento.');
    expect(content).toContain('1. Aguardando 1');
    expect(content).toContain('Lobby #7');
    expect(content).toContain('Bot-Fubinha (Sub)👑');
    expect(content).toContain('Lobby #8');
    expect(content).toContain('Jogador Ativo');
  });

  test('habilita e desabilita o botão de entrada conforme o estado', () => {
    const openRow = queueMessageService.createActionRow(true).toJSON();
    const closedRow = queueMessageService.createActionRow(false).toJSON();

    expect(openRow.components[0].disabled).toBe(false);
    expect(openRow.components[1].disabled).toBe(false);
    expect(closedRow.components[0].disabled).toBe(true);
    expect(closedRow.components[1].disabled).toBe(true);
    expect(openRow.components[0].custom_id).toBe('join_queue');
    expect(openRow.components[1].custom_id).toBe('leave_queue');
  });

  test('exclusão da mensagem principal recria exatamente uma mensagem', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    const recreatedMessage = {
      id: 'new-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockResolvedValue(undefined),
    };

    channel.send.mockResolvedValue(recreatedMessage);
    channel.messages.fetch.mockImplementation(async (messageId) => {
      if (messageId === 'new-msg') {
        return recreatedMessage;
      }
      if (messageId && typeof messageId === 'string' && messageId.startsWith('old')) {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }
      return new Map();
    });
    queueMessageService.registerPanelMessageDeleteHandler(client);

    await queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] }, { forceCreate: true });

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(client.queuePanelMessageId).toBe('new-msg');
    expect(channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.set).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.create).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.delete).not.toHaveBeenCalled();
  });

  test('erro 10008 durante edit recria exatamente uma vez', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockRejectedValue(Object.assign(new Error('Unknown Message'), { code: 10008 })),
    };
    const recreatedMessage = {
      id: 'new-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockResolvedValue(undefined),
    };

    channel.send.mockResolvedValue(recreatedMessage);
    channel.messages.fetch.mockImplementation((messageId) => {
      if (messageId === 'new-msg') {
        return Promise.resolve(recreatedMessage);
      }
      return Promise.resolve(existingMessage);
    });

    await queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] });
    await queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] });

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.set).not.toHaveBeenCalled();
  });

  test('startup reutiliza painel existente quando a mensagem ainda existe', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockResolvedValue(undefined),
    };

    channel.messages.fetch.mockResolvedValue(existingMessage);

    const result = await queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] });

    expect(result.id).toBe('old-msg');
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.set).not.toHaveBeenCalled();
  });

  test('exclusão de outra mensagem do bot não recria painel', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    queueMessageService.registerPanelMessageDeleteHandler(client);

    client.emit(Events.MessageDelete, {
      id: 'other-msg',
      author: { id: 'bot-id' },
      channel,
      content: 'outro texto',
    });

    await Promise.resolve();
    expect(channel.send).not.toHaveBeenCalled();
  });

  test('exclusão de mensagem de usuário não recria painel', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    queueMessageService.registerPanelMessageDeleteHandler(client);

    client.emit(Events.MessageDelete, {
      id: 'user-msg',
      author: { id: 'user-id' },
      channel,
      content: '# 🎮 Sistema de Fila',
    });

    await Promise.resolve();
    expect(channel.send).not.toHaveBeenCalled();
  });

  test('exclusão em outro canal não recria painel', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client, 'other-channel');
    queueMessageService.registerPanelMessageDeleteHandler(client);

    client.emit(Events.MessageDelete, {
      id: 'old-msg',
      author: { id: 'bot-id' },
      channel,
      content: '# 🎮 Sistema de Fila',
    });

    await Promise.resolve();
    expect(channel.send).not.toHaveBeenCalled();
  });

  test('depois da recriação a próxima atualização edita a nova mensagem e não chama novo send', async () => {
    const client = { user: { id: 'bot-id' }, queuePanelMessageId: 'old-msg' };
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockRejectedValue(Object.assign(new Error('Unknown Message'), { code: 10008 })),
    };
    const recreatedMessage = {
      id: 'new-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockResolvedValue(undefined),
    };

    channel.send.mockResolvedValue(recreatedMessage);
    channel.messages.fetch.mockImplementation((messageId) => {
      if (messageId === 'new-msg') {
        return Promise.resolve(recreatedMessage);
      }
      return Promise.resolve(existingMessage);
    });

    await queueMessageService.recoverPanelMessage(channel, { content: 'first', components: [] });
    await queueMessageService.recoverPanelMessage(channel, { content: 'second', components: [] });

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(recreatedMessage.edit).toHaveBeenCalledTimes(1);
  });

  test('duas atualizações concorrentes após 10008 criam somente um painel', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockRejectedValue(Object.assign(new Error('Unknown Message'), { code: 10008 })),
    };
    const recreatedMessage = {
      id: 'new-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockResolvedValue(undefined),
    };

    channel.send.mockResolvedValue(recreatedMessage);
    channel.messages.fetch.mockImplementation((messageId) => {
      if (messageId === 'new-msg') {
        return Promise.resolve(recreatedMessage);
      }
      return Promise.resolve(existingMessage);
    });

    await Promise.all([
      queueMessageService.recoverPanelMessage(channel, { content: 'one', components: [] }),
      queueMessageService.recoverPanelMessage(channel, { content: 'two', components: [] }),
    ]);

    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  test('startup sem painel cria exatamente um', async () => {
    const client = createMockClient();
    client.queuePanelMessageId = null;
    const channel = createMockChannel(client);
    const createdMessage = {
      id: 'created-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockResolvedValue(undefined),
    };

    channel.messages.fetch.mockResolvedValue(null);
    channel.send.mockResolvedValue(createdMessage);

    const result = await queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] });

    expect(result.id).toBe('created-msg');
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(client.queuePanelMessageId).toBe('created-msg');
  });

  test('mensagem recriada representa estado atual do painel', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockRejectedValue(Object.assign(new Error('Unknown Message'), { code: 10008 })),
    };
    const recreatedMessage = {
      id: 'new-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockResolvedValue(undefined),
    };

    channel.send.mockResolvedValue(recreatedMessage);
    channel.messages.fetch.mockResolvedValue(existingMessage);

    await queueMessageService.recoverPanelMessage(channel, {
      content: '# 🎮 Sistema de Fila\nFila fechada',
      components: [{ type: 1, components: [{ custom_id: 'join_queue', disabled: true }] }],
    });

    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Fila fechada') }));
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ components: expect.any(Array) }));
  });

  test('erro 50013 não inicia retry ou loop de criação', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockRejectedValue(Object.assign(new Error('Missing Permissions'), { code: 50013 })),
    };

    channel.messages.fetch.mockResolvedValue(existingMessage);

    const result = await queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] });

    expect(result).toEqual(existingMessage);
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.set).not.toHaveBeenCalled();
  });

  test('erro 50001 não inicia retry ou loop de criação', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockRejectedValue(Object.assign(new Error('Missing Access'), { code: 50001 })),
    };

    channel.messages.fetch.mockResolvedValue(existingMessage);

    const result = await queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] });

    expect(result).toEqual(existingMessage);
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.set).not.toHaveBeenCalled();
  });

  test('updatePanel sem acesso retorna código seguro sem alterar overwrites', async () => {
    require('../src/config').queuePanelChannelId = 'panel-channel';
    const client = createMockClient();
    client.channels = {
      fetch: jest.fn().mockRejectedValue(Object.assign(new Error('Missing Access'), { code: 50001 })),
    };

    const result = await queueMessageService.updatePanel(client, { isQueueOpen: false });

    expect(result).toEqual({ updated: false, code: 'CHANNEL_ACCESS_DENIED' });
  });

  test('estado shutting_down não recria painel', async () => {
    const client = { user: { id: 'bot-id' }, queuePanelMessageId: 'old-msg' };
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockRejectedValue(Object.assign(new Error('Unknown Message'), { code: 10008 })),
    };

    const lifecycleService = require('../src/services/applicationLifecycleService');
    lifecycleService.beginShutdown('test');

    channel.messages.fetch.mockResolvedValue(existingMessage);

    const result = await queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] });

    expect(result).toBeNull();
    expect(channel.send).not.toHaveBeenCalled();

    lifecycleService._resetForTests();
  });

  test('estados stopped e failed não recriam painel', async () => {
    const lifecycleService = require('../src/services/applicationLifecycleService');
    lifecycleService.markFailed('test');

    const client = createMockClient();
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockRejectedValue(Object.assign(new Error('Unknown Message'), { code: 10008 })),
    };

    channel.messages.fetch.mockResolvedValue(existingMessage);

    const result = await queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] });

    expect(result).toBeNull();
    expect(channel.send).not.toHaveBeenCalled();

    lifecycleService._resetForTests();
  });

  test('erro desconhecido não provoca retry infinito', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockRejectedValue(new Error('network down')),
    };

    channel.messages.fetch.mockResolvedValue(existingMessage);

    await expect(queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] })).rejects.toThrow('network down');
  });

  test('cache contém somente o ID da nova mensagem após recuperação', async () => {
    const client = createMockClient();
    const channel = createMockChannel(client);
    const existingMessage = {
      id: 'old-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockRejectedValue(Object.assign(new Error('Unknown Message'), { code: 10008 })),
    };
    const recreatedMessage = {
      id: 'new-msg',
      author: { id: 'bot-id' },
      content: '# 🎮 Sistema de Fila',
      edit: jest.fn().mockResolvedValue(undefined),
    };

    channel.send.mockResolvedValue(recreatedMessage);
    channel.messages.fetch.mockResolvedValue(existingMessage);

    await queueMessageService.recoverPanelMessage(channel, { content: 'new', components: [] });

    expect(client.queuePanelMessageId).toBe('new-msg');
  });
});
