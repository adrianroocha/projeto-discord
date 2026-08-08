jest.mock('../src/services/queueMessageService', () => ({
  updatePanel: jest.fn().mockResolvedValue(undefined),
}));

const { createTestContext, getDb, countRows, insertLobby, insertLobbyPlayer, seedQueueEntry } = require('./helpers/testDatabase');

function createClientStub(queueChannelId) {
  const permissionOverwrites = {
    edit: jest.fn().mockResolvedValue(undefined),
  };

  const channel = {
    isTextBased: () => true,
    guild: {
      roles: {
        everyone: { id: 'everyone-role' },
      },
    },
    permissionOverwrites,
  };

  return {
    user: { id: 'bot-user' },
    channels: {
      cache: new Map([[queueChannelId, channel]]),
      fetch: jest.fn().mockResolvedValue(channel),
    },
  };
}

describe('scheduler service', () => {
  let context;
  let db;
  let schedulerService;
  let client;
  let panelService;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    context = await createTestContext({ nodeEnv: 'development', queueChannelId: 'queue-channel' });
    db = getDb(context.sqliteClient);
    schedulerService = require('../src/services/schedulerService');
    schedulerService.resetSchedulerStopFlag();
    panelService = require('../src/services/queueMessageService');
    client = createClientStub('queue-channel');
  });

  afterEach(async () => {
    jest.useRealTimers();
    await context.cleanup();
  });

  function seedDirtyCycle() {
    seedQueueEntry(db, {
      id: 1,
      discordId: 'waiting-1',
      username: 'Waiting 1#0001',
      displayName: 'Waiting 1',
      isSubscriber: 0,
      joinedAtMs: 1_000,
    });

    insertLobby(db, {
      id: 10,
      lobbyNumber: 10,
      status: 'forming',
      creationType: 'automatic',
      createdAtMs: 2_000,
    });
    insertLobbyPlayer(db, {
      id: 10,
      lobbyId: 10,
      discordId: 'forming-1',
      username: 'Forming 1#0001',
      displayName: 'Forming 1',
      position: 1,
      originalJoinedAtMs: 2_000,
      isSubscriber: 0,
    });

    insertLobby(db, {
      id: 20,
      lobbyNumber: 20,
      status: 'forming',
      creationType: 'forced',
      createdAtMs: 3_000,
    });
    insertLobbyPlayer(db, {
      id: 20,
      lobbyId: 20,
      discordId: 'forced-1',
      username: 'Forced 1#0001',
      displayName: 'Forced 1',
      position: 1,
      originalJoinedAtMs: 3_000,
      isSubscriber: 0,
    });

    insertLobby(db, {
      id: 30,
      lobbyNumber: 30,
      status: 'in_game',
      creationType: 'automatic',
      createdAtMs: 4_000,
    });
    insertLobbyPlayer(db, {
      id: 30,
      lobbyId: 30,
      discordId: 'in-game-1',
      username: 'In Game 1#0001',
      displayName: 'In Game 1',
      position: 1,
      originalJoinedAtMs: 4_000,
      isSubscriber: 0,
    });
  }

  test('ciclo de desenvolvimento abre imediatamente, limpa tudo e repete', async () => {
    seedDirtyCycle();

    schedulerService.startScheduler(client);
    await Promise.resolve();
    await Promise.resolve();

    expect(schedulerService.isQueueOpen()).toBe(true);
    expect(countRows(db, 'queue_entries')).toBe(0);
    expect(countRows(db, 'lobby_players')).toBe(0);
    expect(countRows(db, 'lobbies')).toBe(0);
    expect(panelService.updatePanel).toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(schedulerService.isQueueOpen()).toBe(false);

    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(schedulerService.isQueueOpen()).toBe(true);
  });

  test('startScheduler não duplica timers', async () => {
    schedulerService.startScheduler(client);
    schedulerService.startScheduler(client);
    await Promise.resolve();
    await Promise.resolve();

    expect(schedulerService.isQueueOpen()).toBe(true);
    expect(panelService.updatePanel).toHaveBeenCalledTimes(1);
  });

  test('scheduler-open e scheduler-close usam o mesmo serviço manual', async () => {
    const schedulerOpen = require('../src/commands/schedulerOpen');
    const schedulerClose = require('../src/commands/schedulerClose');
    const openSpy = jest.spyOn(schedulerService, 'openQueue');
    const closeSpy = jest.spyOn(schedulerService, 'closeQueue');

    const interaction = {
      client,
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
    };

    await schedulerOpen.execute(interaction);
    await schedulerClose.execute(interaction);

    expect(openSpy).toHaveBeenCalledWith(client, { manual: true });
    expect(closeSpy).toHaveBeenCalledWith(client, { manual: true });
    expect(interaction.editReply).toHaveBeenNthCalledWith(2, '🔒 Fila fechada manualmente. O ciclo atual foi preservado.');
  });

  test('stopScheduler cancela timers e impede novo ciclo após shutdown', async () => {
    schedulerService.startScheduler(client);
    await Promise.resolve();
    await Promise.resolve();

    expect(schedulerService.isQueueOpen()).toBe(true);

    schedulerService.stopScheduler();

    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(panelService.updatePanel).toHaveBeenCalledTimes(1);
  });
});
