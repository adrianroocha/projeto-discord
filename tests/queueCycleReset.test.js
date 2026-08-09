jest.mock('../src/services/queueMessageService', () => ({
  updatePanel: jest.fn().mockResolvedValue(undefined),
}));

const { createTestContext, getDb, countRows, insertLobby, insertLobbyPlayer, seedQueueEntry } = require('./helpers/testDatabase');
const queueMessageService = require('../src/services/queueMessageService');

describe('queue cycle reset', () => {
  let context;
  let db;
  let schedulerService;

  beforeEach(async () => {
    context = await createTestContext({ nodeEnv: 'development', queueChannelId: 'queue-channel' });
    db = getDb(context.sqliteClient);
    schedulerService = require('../src/services/schedulerService');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  function seedCompleteCycle() {
    seedQueueEntry(db, {
      id: 1,
      discordId: 'waiting-cycle-1',
      username: 'Waiting Cycle 1#0001',
      displayName: 'Waiting Cycle 1',
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
      discordId: 'auto-cycle-1',
      username: 'Auto Cycle 1#0001',
      displayName: 'Auto Cycle 1',
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
      discordId: 'forced-cycle-1',
      username: 'Forced Cycle 1#0001',
      displayName: 'Forced Cycle 1',
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
      discordId: 'game-cycle-1',
      username: 'Game Cycle 1#0001',
      displayName: 'Game Cycle 1',
      position: 1,
      originalJoinedAtMs: 4_000,
      isSubscriber: 0,
    });
  }

  test('resetQueueCycle apaga todo o estado do ciclo', () => {
    seedCompleteCycle();

    expect(countRows(db, 'queue_entries')).toBe(1);
    expect(countRows(db, 'lobby_players')).toBe(3);
    expect(countRows(db, 'lobbies')).toBe(3);

    const result = context.queueService.resetQueueCycle();
    expect(result).toBe(true);
    expect(countRows(db, 'queue_entries')).toBe(0);
    expect(countRows(db, 'lobby_players')).toBe(0);
    expect(countRows(db, 'lobbies')).toBe(0);
  });

  test('resetQueueCycle faz rollback se a transação falhar', () => {
    seedCompleteCycle();

    const initialCounts = {
      queueEntries: countRows(db, 'queue_entries'),
      lobbyPlayers: countRows(db, 'lobby_players'),
      lobbies: countRows(db, 'lobbies'),
    };

    const realPrepare = db.prepare.bind(db);
    jest.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = realPrepare(sql);
      if (sql === 'DELETE FROM lobbies') {
        return {
          run: (...args) => {
            const result = statement.run(...args);
            throw new Error('forced reset failure');
          },
        };
      }
      return statement;
    });

    expect(() => context.queueService.resetQueueCycle()).toThrow('forced reset failure');
    expect(countRows(db, 'queue_entries')).toBe(initialCounts.queueEntries);
    expect(countRows(db, 'lobby_players')).toBe(initialCounts.lobbyPlayers);
    expect(countRows(db, 'lobbies')).toBe(initialCounts.lobbies);
  });

  test('openQueue mantém a fila fechada se reset falhar', async () => {
    const resetSpy = jest.spyOn(context.queueService, 'resetQueueCycle').mockImplementation(() => {
      throw new Error('reset boom');
    });
    const updatePanelSpy = queueMessageService.updatePanel;

    const client = {
      user: { id: 'bot-user' },
      channels: {
        cache: new Map([
          [
            'queue-channel',
            {
              isTextBased: () => true,
              guild: { roles: { everyone: { id: 'everyone-role' } } },
              permissionOverwrites: {
                edit: jest.fn().mockResolvedValue(undefined),
                set: jest.fn().mockResolvedValue(undefined),
                create: jest.fn().mockResolvedValue(undefined),
                delete: jest.fn().mockResolvedValue(undefined),
              },
            },
          ],
        ]),
        fetch: jest.fn(),
      },
    };

    const result = await schedulerService.openQueue(client, { manual: true });

    expect(result).toBe(false);
    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(updatePanelSpy).not.toHaveBeenCalled();
    const channel = client.channels.cache.get('queue-channel');
    expect(channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.set).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.create).not.toHaveBeenCalled();
    expect(channel.permissionOverwrites.delete).not.toHaveBeenCalled();
  });
});
