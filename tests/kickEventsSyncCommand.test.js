jest.mock('../src/services/kickEventSubscriptionService', () => ({
  syncDesiredEvents: jest.fn(),
}));

const { PermissionFlagsBits } = require('discord.js');
const kickEventSubscriptionService = require('../src/services/kickEventSubscriptionService');
const command = require('../src/commands/kickEventsSync');

function makeAdminPermissions(isAdmin) {
  return {
    has: (permissionFlag) =>
      permissionFlag === PermissionFlagsBits.Administrator && Boolean(isAdmin),
  };
}

function createInteraction(overrides = {}) {
  return {
    inGuild: () => true,
    memberPermissions: makeAdminPermissions(true),
    user: { id: 'admin-1' },
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('/kick-events-sync command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('somente Administrator pode executar', async () => {
    const interaction = createInteraction({
      memberPermissions: makeAdminPermissions(false),
    });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
      }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(kickEventSubscriptionService.syncDesiredEvents).not.toHaveBeenCalled();
  });

  test('recusa execução em DM', async () => {
    const interaction = createInteraction({
      inGuild: () => false,
    });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        ephemeral: true,
      }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  test('deferReply e resposta final são ephemeral', async () => {
    kickEventSubscriptionService.syncDesiredEvents.mockResolvedValue({
      created: ['channel.subscription.new v1'],
      alreadyActive: ['channel.subscription.gifts v1'],
      failed: [],
    });

    const interaction = createInteraction();

    await command.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
  });

  test('monta mensagem de resumo com criados, já ativos e falhas', async () => {
    kickEventSubscriptionService.syncDesiredEvents.mockResolvedValue({
      created: ['channel.subscription.new v1', 'channel.subscription.renewal v1'],
      alreadyActive: ['channel.subscription.gifts v1'],
      failed: [{ event: 'channel.subscription.renewal v1', reason: 'RATE_LIMITED' }],
    });

    const interaction = createInteraction();
    await command.execute(interaction);

    const content = interaction.editReply.mock.calls[0][0];
    expect(content).toContain('Sincronização dos eventos Kick concluída.');
    expect(content).toContain('Criados:');
    expect(content).toContain('- channel.subscription.new v1');
    expect(content).toContain('Já ativos:');
    expect(content).toContain('- channel.subscription.gifts v1');
    expect(content).toContain('Falhas:');
    expect(content).toContain('- channel.subscription.renewal v1 (RATE_LIMITED)');
  });

  test('erro de configuração incompleta não expõe valor e mostra nome da variável', async () => {
    kickEventSubscriptionService.syncDesiredEvents.mockRejectedValue({
      code: 'MISSING_CONFIG',
      missingVar: 'KICK_CLIENT_SECRET',
      message: 'token secret abc123',
    });

    const interaction = createInteraction();
    await command.execute(interaction);

    const content = interaction.editReply.mock.calls[0][0];
    expect(content).toBe(
      'Configuração incompleta: variável obrigatória ausente KICK_CLIENT_SECRET.',
    );
    expect(content).not.toContain('abc123');
  });

  test('exibe message seguro retornado pela Kick quando disponível', async () => {
    kickEventSubscriptionService.syncDesiredEvents.mockRejectedValue({
      code: 'BAD_REQUEST',
      upstreamMessage: 'Invalid broadcaster_user_id',
    });

    const interaction = createInteraction();
    await command.execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      'Kick API retornou: Invalid broadcaster_user_id',
    );
  });

  test('não altera cargo nem fila durante sincronização de eventos', async () => {
    kickEventSubscriptionService.syncDesiredEvents.mockResolvedValue({
      created: [],
      alreadyActive: ['channel.subscription.new v1', 'channel.subscription.renewal v1', 'channel.subscription.gifts v1'],
      failed: [],
    });

    const interaction = createInteraction({
      member: {
        roles: {
          add: jest.fn(),
          remove: jest.fn(),
        },
      },
      client: {
        queueService: {
          addToQueue: jest.fn(),
          removeFromQueue: jest.fn(),
        },
      },
    });

    await command.execute(interaction);

    expect(interaction.member.roles.add).not.toHaveBeenCalled();
    expect(interaction.member.roles.remove).not.toHaveBeenCalled();
    expect(interaction.client.queueService.addToQueue).not.toHaveBeenCalled();
    expect(interaction.client.queueService.removeFromQueue).not.toHaveBeenCalled();
  });
});
