const { createTestContext, getDb } = require('./helpers/testDatabase');
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

let createKickSubscriptionEventService;
let subscriptionsRepository;
let eventsRepository;

function makeHeaders(overrides = {}) {
  return {
    eventMessageId: 'evt-default',
    eventSubscriptionId: 'sub-default',
    eventType: 'channel.subscription.new',
    eventVersion: '1',
    eventTimestamp: '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('kickSubscriptionEventService', () => {
  let context;
  let db;

  beforeEach(async () => {
    context = await createTestContext();
    db = getDb(context.sqliteClient);
    ({ createKickSubscriptionEventService } = require('../src/services/kickSubscriptionEventService'));
    subscriptionsRepository = require('../src/database/kickSubscriptionsRepository');
    eventsRepository = require('../src/database/kickWebhookEventsRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('processa channel.subscription.new', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 1111,
    });

    const result = service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-new-1', eventType: 'channel.subscription.new' }),
      eventPayload: {
        broadcaster: { user_id: 'b1' },
        subscriber: { user_id: 'u1', username: 'user1' },
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: '2026-09-01T00:00:00.000Z',
      },
    });

    expect(result).toEqual({ status: 'processed', appliedCount: 1 });
    expect(subscriptionsRepository.isActive('b1', 'u1', Date.parse('2026-08-10T00:00:00.000Z'))).toBe(true);
  });

  test('processa channel.subscription.renewal e atualiza expiração', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 2222,
    });

    service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-ren-1', eventType: 'channel.subscription.new' }),
      eventPayload: {
        broadcaster: { user_id: 'b1' },
        subscriber: { user_id: 'u2', username: 'user2' },
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: '2026-09-01T00:00:00.000Z',
      },
    });

    service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-ren-2', eventType: 'channel.subscription.renewal' }),
      eventPayload: {
        broadcaster: { user_id: 'b1' },
        subscriber: { user_id: 'u2', username: 'user2' },
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: '2026-10-01T00:00:00.000Z',
      },
    });

    const row = subscriptionsRepository.findByBroadcasterAndKickUser('b1', 'u2');
    expect(row.expires_at_ms).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
  });

  test('processa channel.subscription.gifts para múltiplos giftees', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 3333,
    });

    const result = service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-gifts-1', eventType: 'channel.subscription.gifts' }),
      eventPayload: {
        broadcaster: { user_id: 'b1' },
        giftees: [
          { user_id: 'u3', username: 'gifted-a' },
          { user_id: 'u4', username: 'gifted-b' },
        ],
        created_at: '2026-08-02T00:00:00.000Z',
        expires_at: '2026-09-02T00:00:00.000Z',
      },
    });

    expect(result).toEqual({ status: 'processed', appliedCount: 2 });
    expect(subscriptionsRepository.findByBroadcasterAndKickUser('b1', 'u3').subscription_type).toBe('gifted');
    expect(subscriptionsRepository.findByBroadcasterAndKickUser('b1', 'u4').subscription_type).toBe('gifted');
  });

  test('evento duplicado retorna duplicate sem alterar estado', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 4444,
    });

    const payload = {
      broadcaster: { user_id: 'b1' },
      subscriber: { user_id: 'u5', username: 'user5' },
      created_at: '2026-08-01T00:00:00.000Z',
      expires_at: '2026-09-01T00:00:00.000Z',
    };

    const headers = makeHeaders({ eventMessageId: 'evt-dup-1', eventType: 'channel.subscription.new' });
    service.processEvent({ eventHeaders: headers, eventPayload: payload });
    const second = service.processEvent({ eventHeaders: headers, eventPayload: payload });

    expect(second).toEqual({ status: 'duplicate', appliedCount: 0 });
  });

  test('evento fora de ordem não reduz expiração', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 5555,
    });

    service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-order-1', eventType: 'channel.subscription.renewal' }),
      eventPayload: {
        broadcaster: { user_id: 'b1' },
        subscriber: { user_id: 'u6', username: 'user6' },
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: '2026-10-01T00:00:00.000Z',
      },
    });

    service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-order-2', eventType: 'channel.subscription.new' }),
      eventPayload: {
        broadcaster: { user_id: 'b1' },
        subscriber: { user_id: 'u6', username: 'user6' },
        created_at: '2026-08-10T00:00:00.000Z',
        expires_at: '2026-09-01T00:00:00.000Z',
      },
    });

    const row = subscriptionsRepository.findByBroadcasterAndKickUser('b1', 'u6');
    expect(row.expires_at_ms).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
  });

  test('ignora broadcaster diferente sem alterar assinaturas', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b-target' },
      now: () => 6666,
      logger: { warn: jest.fn() },
    });

    const result = service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-other-1', eventType: 'channel.subscription.new' }),
      eventPayload: {
        broadcaster: { user_id: 'b-other' },
        subscriber: { user_id: 'u7', username: 'user7' },
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: '2026-09-01T00:00:00.000Z',
      },
    });

    expect(result).toEqual({ status: 'ignored_other_broadcaster', appliedCount: 0 });
    expect(subscriptionsRepository.findByBroadcasterAndKickUser('b-other', 'u7')).toBeNull();
    expect(eventsRepository.hasProcessed('evt-other-1')).toBe(true);
  });

  test('com KICK_BROADCASTER_USER_ID ausente não processa subscription e não grava assinatura', () => {
    const logger = { warn: jest.fn() };
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: null },
      now: () => 7000,
      logger,
    });

    const result = service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-missing-broadcaster-1', eventType: 'channel.subscription.new' }),
      eventPayload: {
        broadcaster: { user_id: 'b-any' },
        subscriber: { user_id: 'u-missing', username: 'user-missing' },
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: '2026-09-01T00:00:00.000Z',
      },
    });

    expect(result).toEqual({ status: 'webhook_disabled_unconfigured', appliedCount: 0 });
    expect(subscriptionsRepository.findByBroadcasterAndKickUser('b-any', 'u-missing')).toBeNull();
    expect(eventsRepository.hasProcessed('evt-missing-broadcaster-1')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'Webhook Kick desabilitado: configuração incompleta para broadcaster.',
    );
  });

  test('evento não suportado não derruba e marca processado', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 7777,
    });

    const result = service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-unknown-1', eventType: 'channel.subscription.cancelled' }),
      eventPayload: {
        broadcaster: { user_id: 'b1' },
      },
    });

    expect(result).toEqual({ status: 'ignored_unsupported', appliedCount: 0 });
    expect(eventsRepository.hasProcessed('evt-unknown-1')).toBe(true);
  });

  test('falha de banco não marca evento processado e permite retry', () => {
    const failOnceRepo = {
      ...subscriptionsRepository,
      upsertFromEvent: jest
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('db-failure');
        })
        .mockImplementation((data, txDb) => subscriptionsRepository.upsertFromEvent(data, txDb)),
    };

    const serviceWithFailure = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 8888,
      kickSubscriptionsRepository: failOnceRepo,
    });

    const payload = {
      broadcaster: { user_id: 'b1' },
      subscriber: { user_id: 'u8', username: 'user8' },
      created_at: '2026-08-01T00:00:00.000Z',
      expires_at: '2026-09-01T00:00:00.000Z',
    };

    expect(() => {
      serviceWithFailure.processEvent({
        eventHeaders: makeHeaders({ eventMessageId: 'evt-retry-1', eventType: 'channel.subscription.new' }),
        eventPayload: payload,
      });
    }).toThrow(/db-failure/);

    expect(eventsRepository.hasProcessed('evt-retry-1')).toBe(false);
    expect(subscriptionsRepository.findByBroadcasterAndKickUser('b1', 'u8')).toBeNull();

    const serviceRetry = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 8899,
    });

    const retry = serviceRetry.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-retry-1', eventType: 'channel.subscription.new' }),
      eventPayload: payload,
    });

    expect(retry).toEqual({ status: 'processed', appliedCount: 1 });
    expect(eventsRepository.hasProcessed('evt-retry-1')).toBe(true);
  });

  test('preserva started_at mais antigo e atualiza username', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 9000,
    });

    service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-user-1', eventType: 'channel.subscription.new' }),
      eventPayload: {
        broadcaster: { user_id: 'b1' },
        subscriber: { user_id: 'u9', username: 'old-name' },
        created_at: '2026-08-05T00:00:00.000Z',
        expires_at: '2026-09-05T00:00:00.000Z',
      },
    });

    service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-user-2', eventType: 'channel.subscription.renewal' }),
      eventPayload: {
        broadcaster: { user_id: 'b1' },
        subscriber: { user_id: 'u9', username: 'new-name' },
        created_at: '2026-08-10T00:00:00.000Z',
        expires_at: '2026-10-05T00:00:00.000Z',
      },
    });

    const row = subscriptionsRepository.findByBroadcasterAndKickUser('b1', 'u9');
    expect(row.started_at_ms).toBe(Date.parse('2026-08-05T00:00:00.000Z'));
    expect(row.kick_username).toBe('new-name');
  });

  test('não altera filas/lobbies durante processamento de webhook', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 9999,
    });

    service.processEvent({
      eventHeaders: makeHeaders({ eventMessageId: 'evt-no-queue-1', eventType: 'channel.subscription.new' }),
      eventPayload: {
        broadcaster: { user_id: 'b1' },
        subscriber: { user_id: 'u10', username: 'user10' },
        created_at: '2026-08-01T00:00:00.000Z',
        expires_at: '2026-09-01T00:00:00.000Z',
      },
    });

    const queueCount = db.prepare('SELECT COUNT(1) AS count FROM queue_entries').get();
    const lobbiesCount = db.prepare('SELECT COUNT(1) AS count FROM lobbies').get();
    const lobbyPlayersCount = db.prepare('SELECT COUNT(1) AS count FROM lobby_players').get();

    expect(queueCount.count).toBe(0);
    expect(lobbiesCount.count).toBe(0);
    expect(lobbyPlayersCount.count).toBe(0);
  });
});
