const { createTestContext, getDb } = require('./helpers/testDatabase');
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

let createKickSubscriptionEventService;
let subscriptionsRepository;
let eventsRepository;
let followEventsRepository;

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

function expectProcessingError(fn, code) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeTruthy();
  expect(caught.code).toBe(code);
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
    followEventsRepository = require('../src/database/kickFollowEventsRepository');
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

  test('subscription.new com subscriber ausente rejeita como invalid_payload', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 1112,
    });

    expectProcessingError(() => {
      service.processEvent({
        eventHeaders: makeHeaders({ eventMessageId: 'evt-sub-invalid-1', eventType: 'channel.subscription.new' }),
        eventPayload: {
          broadcaster: { user_id: 'b1' },
          subscriber: { username: 'user1' },
          created_at: '2026-08-01T00:00:00.000Z',
          expires_at: '2026-09-01T00:00:00.000Z',
        },
      });
    }, 'invalid_payload');

    expect(eventsRepository.hasProcessed('evt-sub-invalid-1')).toBe(false);
    expect(subscriptionsRepository.findByBroadcasterAndKickUser('b1', 'u-invalid')).toBeNull();
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

  test('processa channel.followed válido e audita sem criar kick_subscription', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: '101' },
      now: () => 9_999,
    });

    const result = service.processEvent({
      eventHeaders: makeHeaders({
        eventMessageId: 'evt-follow-1',
        eventType: 'channel.followed',
        eventTimestamp: '2026-08-06T12:00:00.000Z',
      }),
      eventPayload: {
        broadcaster: { user_id: 101, username: 'broadcaster-name' },
        follower: { user_id: 202, username: 'follow-user-1' },
      },
    });

    expect(result).toEqual({ status: 'processed', appliedCount: 1 });

    const follow = followEventsRepository.findByEventMessageId('evt-follow-1');
    expect(follow).toEqual(
      expect.objectContaining({
        event_message_id: 'evt-follow-1',
        broadcaster_user_id: '101',
        follower_user_id: '202',
        follower_username: 'follow-user-1',
        followed_at_ms: Date.parse('2026-08-06T12:00:00.000Z'),
        received_at_ms: 9999,
      }),
    );

    expect(eventsRepository.hasProcessed('evt-follow-1')).toBe(true);
    expect(subscriptionsRepository.findByBroadcasterAndKickUser('101', '202')).toBeNull();
    const subscriptionRows = db.prepare('SELECT COUNT(1) AS count FROM kick_subscriptions').get();
    const queueRows = db.prepare('SELECT COUNT(1) AS count FROM queue_entries').get();
    expect(subscriptionRows.count).toBe(0);
    expect(queueRows.count).toBe(0);
  });

  test('channel.followed de outro broadcaster é ignorado sem criar follow', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b-target' },
      now: () => 10_100,
      logger: { warn: jest.fn() },
    });

    const result = service.processEvent({
      eventHeaders: makeHeaders({
        eventMessageId: 'evt-follow-other-1',
        eventType: 'channel.followed',
      }),
      eventPayload: {
        broadcaster: { user_id: 'b-other' },
        follower: { user_id: 'f2', username: 'follow-user-2' },
      },
    });

    expect(result).toEqual({ status: 'ignored_other_broadcaster', appliedCount: 0 });
    expect(eventsRepository.hasProcessed('evt-follow-other-1')).toBe(true);
    expect(followEventsRepository.findByEventMessageId('evt-follow-other-1')).toBeNull();
  });

  test('channel.followed duplicado não cria segundo registro', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 11_100,
    });

    const payload = {
      broadcaster: { user_id: 'b1' },
      follower: { user_id: 'f3', username: 'follow-user-3' },
    };

    const headers = makeHeaders({
      eventMessageId: 'evt-follow-dup-1',
      eventType: 'channel.followed',
      eventTimestamp: '2026-08-06T13:00:00.000Z',
    });

    const first = service.processEvent({ eventHeaders: headers, eventPayload: payload });
    const second = service.processEvent({ eventHeaders: headers, eventPayload: payload });

    expect(first).toEqual({ status: 'processed', appliedCount: 1 });
    expect(second).toEqual({ status: 'duplicate', appliedCount: 0 });
    expect(followEventsRepository.countAll()).toBe(1);
  });

  test('channel.followed inválido rejeita follower ausente', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 12_100,
    });

    expectProcessingError(() => {
      service.processEvent({
        eventHeaders: makeHeaders({
          eventMessageId: 'evt-follow-invalid-1',
          eventType: 'channel.followed',
        }),
        eventPayload: {
          broadcaster: { user_id: 'b1' },
          follower: { user_id: '', username: '' },
        },
      });
    }, 'invalid_follower');

    expect(eventsRepository.hasProcessed('evt-follow-invalid-1')).toBe(false);
    expect(followEventsRepository.findByEventMessageId('evt-follow-invalid-1')).toBeNull();
  });

  test('channel.followed com eventTimestamp inválido falha de forma controlada', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 13_100,
    });

    expectProcessingError(() => {
      service.processEvent({
        eventHeaders: makeHeaders({
          eventMessageId: 'evt-follow-invalid-ts-1',
          eventType: 'channel.followed',
          eventTimestamp: 'invalid-date',
        }),
        eventPayload: {
          broadcaster: { user_id: 'b1' },
          follower: { user_id: 'f4', username: 'follow-user-4' },
        },
      });
    }, 'invalid_event_timestamp');
  });

  test('channel.followed com eventTimestamp ausente falha de forma controlada', () => {
    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 13_200,
    });

    expectProcessingError(() => {
      service.processEvent({
        eventHeaders: makeHeaders({
          eventMessageId: 'evt-follow-missing-ts-1',
          eventType: 'channel.followed',
          eventTimestamp: '',
        }),
        eventPayload: {
          broadcaster: { user_id: 'b1' },
          follower: { user_id: 'f4', username: 'follow-user-4' },
        },
      });
    }, 'invalid_event_timestamp');
  });

  test('persistência atômica: se falhar em follow_events não grava evento processado', () => {
    const failingFollowRepo = {
      ...followEventsRepository,
      registerFollowEvent: jest.fn(() => {
        throw new Error('db-follow-failure');
      }),
    };

    const service = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 14_100,
      kickFollowEventsRepository: failingFollowRepo,
    });

    expectProcessingError(() => {
      service.processEvent({
        eventHeaders: makeHeaders({
          eventMessageId: 'evt-follow-atomic-1',
          eventType: 'channel.followed',
        }),
        eventPayload: {
          broadcaster: { user_id: 'b1' },
          follower: { user_id: 'f5', username: 'follow-user-5' },
        },
      });
    }, 'database_error');

    expect(eventsRepository.hasProcessed('evt-follow-atomic-1')).toBe(false);
    expect(followEventsRepository.findByEventMessageId('evt-follow-atomic-1')).toBeNull();
  });

  test('falha de banco em follow permite retry', () => {
    const failOnceRepo = {
      ...followEventsRepository,
      registerFollowEvent: jest
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('db-failure-once');
        })
        .mockImplementation((data, txDb) =>
          followEventsRepository.registerFollowEvent(data, txDb),
        ),
    };

    const serviceFailing = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 15_100,
      kickFollowEventsRepository: failOnceRepo,
    });

    const payload = {
      broadcaster: { user_id: 'b1' },
      follower: { user_id: 'f6', username: 'follow-user-6' },
    };

    const headers = makeHeaders({
      eventMessageId: 'evt-follow-retry-1',
      eventType: 'channel.followed',
      eventTimestamp: '2026-08-06T14:00:00.000Z',
    });

    expectProcessingError(() => {
      serviceFailing.processEvent({ eventHeaders: headers, eventPayload: payload });
    }, 'database_error');

    expect(eventsRepository.hasProcessed('evt-follow-retry-1')).toBe(false);

    const serviceRetry = createKickSubscriptionEventService({
      config: { kickBroadcasterUserId: 'b1' },
      now: () => 15_200,
    });

    const retryResult = serviceRetry.processEvent({ eventHeaders: headers, eventPayload: payload });
    expect(retryResult).toEqual({ status: 'processed', appliedCount: 1 });
    expect(eventsRepository.hasProcessed('evt-follow-retry-1')).toBe(true);
    expect(followEventsRepository.findByEventMessageId('evt-follow-retry-1')).not.toBeNull();
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

    expectProcessingError(() => {
      serviceWithFailure.processEvent({
        eventHeaders: makeHeaders({ eventMessageId: 'evt-retry-1', eventType: 'channel.subscription.new' }),
        eventPayload: payload,
      });
    }, 'database_error');

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
