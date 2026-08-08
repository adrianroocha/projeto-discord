jest.mock('../src/services/queueService', () => ({
  addToQueue: jest.fn(),
}));

function makeMemberPermissions(isAdminOrManager) {
  return {
    has: (flag) => {
      const { PermissionsBitField } = require('discord.js');
      if (!isAdminOrManager) {
        return false;
      }
      return (
        flag === PermissionsBitField.Flags.Administrator ||
        flag === PermissionsBitField.Flags.ManageGuild
      );
    },
  };
}

function makeInteraction(overrides = {}) {
  return {
    options: {
      getUser: jest.fn().mockReturnValue({
        id: 'target-1',
        username: 'target',
        discriminator: '0001',
        tag: 'target#0001',
      }),
      getMember: jest.fn().mockReturnValue({ displayName: 'Target Display' }),
      getBoolean: jest.fn().mockReturnValue(true),
    },
    member: {
      permissions: makeMemberPermissions(true),
    },
    reply: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('/fila-add-teste command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fora de development recusa sem escrever na fila', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.GUILD_ID = 'test-guild';
    process.env.NODE_ENV = 'production';

    let command;
    let queueService;
    jest.isolateModules(() => {
      command = require('../src/commands/queueAddTest');
      queueService = require('../src/services/queueService');
    });
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining('Ferramenta de desenvolvimento'),
      }),
    );
    expect(queueService.addToQueue).not.toHaveBeenCalled();

    delete process.env.NODE_ENV;
    delete process.env.DISCORD_TOKEN;
    delete process.env.GUILD_ID;
  });

  test('em development mantém parâmetro manual subscriber', async () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.GUILD_ID = 'test-guild';
    process.env.NODE_ENV = 'development';

    let command;
    let queueService;
    jest.isolateModules(() => {
      command = require('../src/commands/queueAddTest');
      queueService = require('../src/services/queueService');
    });
    queueService.addToQueue.mockReturnValue({ success: true });

    const interaction = makeInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({
          id: 'target-2',
          username: 'target2',
          discriminator: '0002',
          tag: 'target2#0002',
        }),
        getMember: jest.fn().mockReturnValue({ displayName: 'Target 2' }),
        getBoolean: jest.fn().mockReturnValue(true),
      },
    });

    await command.execute(interaction);

    expect(queueService.addToQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'target-2',
        isSubscriber: 1,
      }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Ferramenta de desenvolvimento'),
      }),
    );

    delete process.env.NODE_ENV;
    delete process.env.DISCORD_TOKEN;
    delete process.env.GUILD_ID;
  });
});
