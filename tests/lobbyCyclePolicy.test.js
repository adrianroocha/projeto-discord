const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');

const { createTestContext, getDb, insertLobby, insertLobbyPlayer } = require('./helpers/testDatabase');

function makeQueueChannelStub() {
  return {
    isTextBased: () => true,
    guild: {
      roles: {
        everyone: { id: 'everyone-role' },
      },
    },
    permissionOverwrites: {
      edit: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function makeSchedulerClient(queueChannelId) {
  const channel = makeQueueChannelStub();
  return {
    user: { id: 'bot-user' },
    channels: {
      cache: new Map([[queueChannelId, channel]]),
      fetch: jest.fn().mockResolvedValue(channel),
    },
  };
}

function makeLobbyStartInteraction(client, lobbyNumber = null) {
  const { PermissionsBitField } = require('discord.js');
  return {
    member: {
      permissions: {
        has: (flag) => flag === PermissionsBitField.Flags.ManageGuild,
      },
    },
    options: {
      getInteger: jest.fn().mockReturnValue(lobbyNumber),
    },
    client,
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

function makeJoinInteraction(userId) {
  return {
    user: {
      id: userId,
      username: `user-${userId}`,
      discriminator: '0001',
    },
    member: {
      displayName: `User ${userId}`,
    },
    client: {},
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('lobby cycle policy', () => {
  let context;
  let db;
  let queueService;
  let lobbyStartCommand;
  let joinQueueButton;
  let schedulerService;
  let queueMessageService;
  let subscriberEligibilityService;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));

    context = await createTestContext({
      nodeEnv: 'development',
      queueChannelId: 'queue-channel',
      queuePanelChannelId: '',
      subscriberRoleId: 'role-sub',
      kickBroadcasterUserId: 'broadcaster-1',
    });

    db = getDb(context.sqliteClient);
    queueService = context.queueService;

    lobbyStartCommand = require('../src/commands/lobbyStart');
    joinQueueButton = require('../src/buttons/joinQueue');
    schedulerService = require('../src/services/schedulerService');
    queueMessageService = require('../src/services/queueMessageService');
    subscriberEligibilityService = require('../src/services/subscriberEligibilityService');

    jest.spyOn(queueMessageService, 'updatePanel').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await context.cleanup();
  });

  test('usuário em forming continua bloqueado no join_queue', async () => {
    const openSpy = jest.spyOn(schedulerService, 'isQueueOpen').mockReturnValue(true);

    queueService.addMultipleToQueue([
      { discordId: 'forming-1', username: 'Forming 1#0001', displayName: 'Forming 1', isSubscriber: 0, joinedAtMs: 1_000 },
      { discordId: 'forming-2', username: 'Forming 2#0001', displayName: 'Forming 2', isSubscriber: 0, joinedAtMs: 1_001 },
      { discordId: 'forming-3', username: 'Forming 3#0001', displayName: 'Forming 3', isSubscriber: 0, joinedAtMs: 1_002 },
      { discordId: 'forming-4', username: 'Forming 4#0001', displayName: 'Forming 4', isSubscriber: 0, joinedAtMs: 1_003 },
    ]);

    const interaction = makeJoinInteraction('forming-1');
    await joinQueueButton.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: 'Você já está em uma lobby em formação.',
      }),
    );

    openSpy.mockRestore();
  });

  test('fluxo /lobby-start seguido de join_queue permite reentrada em in_game e reaproveita snapshot SUB', async () => {
    const openSpy = jest.spyOn(schedulerService, 'isQueueOpen').mockReturnValue(true);
    const eligibilitySpy = jest
      .spyOn(subscriberEligibilityService, 'getEligibility')
      .mockReturnValueOnce({
        eligible: true,
        sources: { kick: { active: true }, manual: { active: false } },
      })
      .mockReturnValueOnce({
        eligible: false,
        sources: { kick: { active: false }, manual: { active: false } },
      });

    const firstJoin = makeJoinInteraction('cycle-user-1');
    await joinQueueButton.execute(firstJoin);

    queueService.addMultipleToQueue([
      { discordId: 'cycle-user-2', username: 'Cycle 2#0001', displayName: 'Cycle 2', isSubscriber: 0, joinedAtMs: 2_000 },
      { discordId: 'cycle-user-3', username: 'Cycle 3#0001', displayName: 'Cycle 3', isSubscriber: 0, joinedAtMs: 2_001 },
      { discordId: 'cycle-user-4', username: 'Cycle 4#0001', displayName: 'Cycle 4', isSubscriber: 0, joinedAtMs: 2_002 },
    ]);

    const commandInteraction = makeLobbyStartInteraction({});
    await lobbyStartCommand.execute(commandInteraction);

    const secondJoin = makeJoinInteraction('cycle-user-1');
    await joinQueueButton.execute(secondJoin);

    const queueRow = db
      .prepare('SELECT discord_id, is_subscriber FROM queue_entries WHERE discord_id = ?')
      .get('cycle-user-1');

    expect(queueRow).toBeDefined();
    expect(queueRow.is_subscriber).toBe(1);
    expect(secondJoin.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('Categoria SUB do ciclo atual reaproveitada.'),
      }),
    );
    expect(eligibilitySpy).toHaveBeenCalledTimes(1);

    openSpy.mockRestore();
    eligibilitySpy.mockRestore();
  });

  test('usuário pode participar de segunda lobby no mesmo ciclo e lobby_players preserva histórico das duas', async () => {
    const openSpy = jest.spyOn(schedulerService, 'isQueueOpen').mockReturnValue(true);
    jest.spyOn(subscriberEligibilityService, 'getEligibility').mockReturnValue({
      eligible: false,
      sources: { kick: { active: false }, manual: { active: false } },
    });

    const firstJoin = makeJoinInteraction('repeat-user-1');
    await joinQueueButton.execute(firstJoin);

    queueService.addMultipleToQueue([
      { discordId: 'repeat-user-2', username: 'Repeat 2#0001', displayName: 'Repeat 2', isSubscriber: 0, joinedAtMs: 10_000 },
      { discordId: 'repeat-user-3', username: 'Repeat 3#0001', displayName: 'Repeat 3', isSubscriber: 0, joinedAtMs: 10_001 },
      { discordId: 'repeat-user-4', username: 'Repeat 4#0001', displayName: 'Repeat 4', isSubscriber: 0, joinedAtMs: 10_002 },
    ]);

    await lobbyStartCommand.execute(makeLobbyStartInteraction({}));

    const secondJoin = makeJoinInteraction('repeat-user-1');
    await joinQueueButton.execute(secondJoin);

    queueService.addMultipleToQueue([
      { discordId: 'repeat-user-5', username: 'Repeat 5#0001', displayName: 'Repeat 5', isSubscriber: 0, joinedAtMs: 20_000 },
      { discordId: 'repeat-user-6', username: 'Repeat 6#0001', displayName: 'Repeat 6', isSubscriber: 0, joinedAtMs: 20_001 },
      { discordId: 'repeat-user-7', username: 'Repeat 7#0001', displayName: 'Repeat 7', isSubscriber: 0, joinedAtMs: 20_002 },
    ]);

    const entries = db
      .prepare(
        `SELECT l.lobby_number, l.status, lp.discord_id
         FROM lobby_players lp
         JOIN lobbies l ON l.id = lp.lobby_id
         WHERE lp.discord_id = ?
         ORDER BY l.lobby_number ASC`,
      )
      .all('repeat-user-1');

    expect(entries.length).toBe(2);
    expect(entries[0].status).toBe('in_game');
    expect(entries[1].status).toBe('forming');

    const secondJoinMessage = secondJoin.reply.mock.calls[0][0]?.content || '';
    expect(secondJoinMessage).not.toContain('in_forming_lobby');
    expect(secondJoinMessage).not.toContain('já está na fila');

    openSpy.mockRestore();
  });

  test('scheduler-close preserva lobbies forming e in_game; scheduler-open limpa lobbies e lobby_players', async () => {
    const client = makeSchedulerClient('queue-channel');

    insertLobby(db, {
      id: 1,
      lobbyNumber: 1,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 1_000,
    });
    insertLobbyPlayer(db, {
      id: 1,
      lobbyId: 1,
      discordId: 'sched-forming-1',
      username: 'Sched Forming 1#0001',
      displayName: 'Sched Forming 1',
      position: 1,
      originalJoinedAtMs: 1_000,
      isSubscriber: 0,
    });

    insertLobby(db, {
      id: 2,
      lobbyNumber: 2,
      status: 'in_game',
      creationType: 'automatic',
      createdAtMs: 2_000,
    });
    insertLobbyPlayer(db, {
      id: 2,
      lobbyId: 2,
      discordId: 'sched-ingame-1',
      username: 'Sched InGame 1#0001',
      displayName: 'Sched InGame 1',
      position: 1,
      originalJoinedAtMs: 2_000,
      isSubscriber: 0,
    });

    await schedulerService.closeQueue(client, { manual: true });

    const countAfterClose = {
      lobbies: db.prepare('SELECT COUNT(1) AS c FROM lobbies').get().c,
      players: db.prepare('SELECT COUNT(1) AS c FROM lobby_players').get().c,
    };

    expect(countAfterClose.lobbies).toBe(2);
    expect(countAfterClose.players).toBe(2);

    await schedulerService.openQueue(client, { manual: true });

    const countAfterOpen = {
      lobbies: db.prepare('SELECT COUNT(1) AS c FROM lobbies').get().c,
      players: db.prepare('SELECT COUNT(1) AS c FROM lobby_players').get().c,
    };

    expect(countAfterOpen.lobbies).toBe(0);
    expect(countAfterOpen.players).toBe(0);
  });

  test('não existe /lobby-finish no código nem no registro de comandos', () => {
    const commandsDir = path.join(process.cwd(), 'src', 'commands');
    const commandFiles = fs.readdirSync(commandsDir).filter((file) => file.endsWith('.js'));

    const hasLobbyFinishFile = commandFiles.some((file) => /lobby.*finish/i.test(file));
    expect(hasLobbyFinishFile).toBe(false);

    const hasSlashName = commandFiles.some((file) => {
      const source = fs.readFileSync(path.join(commandsDir, file), 'utf8');
      return source.includes(".setName('lobby-finish')") || source.includes('.setName("lobby-finish")');
    });
    expect(hasSlashName).toBe(false);

    const commandHandler = require('../src/handlers/commandHandler');
    const client = {};
    commandHandler.loadCommands(client, { nodeEnv: 'development' });

    expect(client.commands.has('lobby-finish')).toBe(false);
  });
});
