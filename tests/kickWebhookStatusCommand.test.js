jest.mock('../src/services/kickWebhookStatusService', () => ({
  getStatus: jest.fn(),
}));

const { PermissionFlagsBits } = require('discord.js');
const kickWebhookStatusService = require('../src/services/kickWebhookStatusService');
const command = require('../src/commands/kickWebhookStatus');

function makeAdminPermissions(isAdmin = true) {
  return {
    has: (flag) => isAdmin && flag === PermissionFlagsBits.Administrator,
  };
}

function makeInteraction(overrides = {}) {
  return {
    inGuild: () => true,
    memberPermissions: makeAdminPermissions(true),
    reply: jest.fn().mockResolvedValue(undefined),
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
    ...overrides,
  };
}

describe('/kick-webhook-status command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sem eventos retorna mensagem padrão', async () => {
    kickWebhookStatusService.getStatus.mockReturnValue({
      webhookConfigured: true,
      broadcasterConfigured: true,
      auditedEventsCount: 0,
      followEventsCount: 0,
      latestEvent: null,
      latestFollow: null,
    });

    const interaction = makeInteraction();
    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain('Nenhum webhook válido recebido até o momento.');
  });

  test('status com follow mostra follower e kick user id', async () => {
    kickWebhookStatusService.getStatus.mockReturnValue({
      webhookConfigured: true,
      broadcasterConfigured: true,
      auditedEventsCount: 3,
      followEventsCount: 2,
      latestEvent: {
        event_message_id: 'evt-follow-status-1',
        event_type: 'channel.followed',
        received_at_ms: 1_700_000_000_000,
      },
      latestFollow: {
        follower_username: 'follow-user-status',
        follower_user_id: 'kick-user-999',
      },
    });

    const interaction = makeInteraction();
    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain('Webhook configurado: sim');
    expect(payload.content).toContain('Broadcaster configurado: sim');
    expect(payload.content).toContain('Tipo: channel.followed');
    expect(payload.content).toContain('Follower: follow-user-status');
    expect(payload.content).toContain('Kick user ID: kick-user-999');
  });

  test('somente Administrator pode usar', async () => {
    const interaction = makeInteraction({
      memberPermissions: makeAdminPermissions(false),
    });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(kickWebhookStatusService.getStatus).not.toHaveBeenCalled();
  });

  test('recusa em DM', async () => {
    const interaction = makeInteraction({
      inGuild: () => false,
    });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(kickWebhookStatusService.getStatus).not.toHaveBeenCalled();
  });

  test('não altera cargo nem fila', async () => {
    kickWebhookStatusService.getStatus.mockReturnValue({
      webhookConfigured: false,
      broadcasterConfigured: false,
      auditedEventsCount: 0,
      followEventsCount: 0,
      latestEvent: null,
      latestFollow: null,
    });

    const interaction = makeInteraction();
    await command.execute(interaction);

    expect(interaction.member.roles.add).not.toHaveBeenCalled();
    expect(interaction.member.roles.remove).not.toHaveBeenCalled();
    expect(interaction.client.queueService.addToQueue).not.toHaveBeenCalled();
    expect(interaction.client.queueService.removeFromQueue).not.toHaveBeenCalled();
  });
});
