const { createTestContext, getDb } = require('./helpers/testDatabase');

describe('kick subscriptions repositories', () => {
  let context;
  let db;
  let subscriptionsRepository;
  let webhookEventsRepository;

  beforeEach(async () => {
    context = await createTestContext();
    db = getDb(context.sqliteClient);
    subscriptionsRepository = require('../src/database/kickSubscriptionsRepository');
    webhookEventsRepository = require('../src/database/kickWebhookEventsRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('cria tabelas kick_subscriptions e kick_webhook_events', () => {
    const subscriptionsTable = db
      .prepare(
        "SELECT COUNT(1) AS count FROM sqlite_master WHERE type='table' AND name='kick_subscriptions'",
      )
      .get();
    const eventsTable = db
      .prepare(
        "SELECT COUNT(1) AS count FROM sqlite_master WHERE type='table' AND name='kick_webhook_events'",
      )
      .get();

    expect(subscriptionsTable.count).toBe(1);
    expect(eventsTable.count).toBe(1);
  });

  test('upsertFromEvent converte datas ISO para ms e cria assinatura', () => {
    const row = subscriptionsRepository.upsertFromEvent({
      broadcasterUserId: 'b1',
      kickUserId: 'u1',
      kickUsername: 'user-one',
      subscriptionType: 'direct',
      startedAtIso: '2026-08-01T00:00:00.000Z',
      expiresAtIso: '2026-09-01T00:00:00.000Z',
      lastEventMessageId: 'evt-1',
      updatedAtMs: 1000,
    });

    expect(row.started_at_ms).toBe(Date.parse('2026-08-01T00:00:00.000Z'));
    expect(row.expires_at_ms).toBe(Date.parse('2026-09-01T00:00:00.000Z'));
  });

  test('renovação fora de ordem não reduz expires_at_ms', () => {
    subscriptionsRepository.upsertFromEvent({
      broadcasterUserId: 'b1',
      kickUserId: 'u2',
      kickUsername: 'user-two',
      subscriptionType: 'direct',
      startedAtIso: '2026-08-01T00:00:00.000Z',
      expiresAtIso: '2026-10-01T00:00:00.000Z',
      lastEventMessageId: 'evt-2',
      updatedAtMs: 1000,
    });

    const updated = subscriptionsRepository.upsertFromEvent({
      broadcasterUserId: 'b1',
      kickUserId: 'u2',
      kickUsername: 'user-two',
      subscriptionType: 'direct',
      startedAtIso: '2026-08-15T00:00:00.000Z',
      expiresAtIso: '2026-09-01T00:00:00.000Z',
      lastEventMessageId: 'evt-3',
      updatedAtMs: 1200,
    });

    expect(updated.expires_at_ms).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
  });

  test('started_at_ms preserva a menor data confiável', () => {
    subscriptionsRepository.upsertFromEvent({
      broadcasterUserId: 'b1',
      kickUserId: 'u3',
      kickUsername: 'old-username',
      subscriptionType: 'direct',
      startedAtIso: '2026-08-05T00:00:00.000Z',
      expiresAtIso: '2026-09-05T00:00:00.000Z',
      lastEventMessageId: 'evt-4',
      updatedAtMs: 1000,
    });

    const updated = subscriptionsRepository.upsertFromEvent({
      broadcasterUserId: 'b1',
      kickUserId: 'u3',
      kickUsername: 'new-username',
      subscriptionType: 'direct',
      startedAtIso: '2026-08-10T00:00:00.000Z',
      expiresAtIso: '2026-10-05T00:00:00.000Z',
      lastEventMessageId: 'evt-5',
      updatedAtMs: 1300,
    });

    expect(updated.started_at_ms).toBe(Date.parse('2026-08-05T00:00:00.000Z'));
    expect(updated.kick_username).toBe('new-username');
  });

  test('isActive e findExpired refletem expiração por expires_at_ms', () => {
    subscriptionsRepository.upsertFromEvent({
      broadcasterUserId: 'b2',
      kickUserId: 'u4',
      kickUsername: 'user-four',
      subscriptionType: 'gifted',
      startedAtIso: '2026-08-01T00:00:00.000Z',
      expiresAtIso: '2026-08-15T00:00:00.000Z',
      lastEventMessageId: 'evt-6',
      updatedAtMs: 1400,
    });

    expect(subscriptionsRepository.isActive('b2', 'u4', Date.parse('2026-08-10T00:00:00.000Z'))).toBe(
      true,
    );
    expect(subscriptionsRepository.isActive('b2', 'u4', Date.parse('2026-08-15T00:00:00.000Z'))).toBe(
      false,
    );

    const expired = subscriptionsRepository.findExpired('b2', Date.parse('2026-08-20T00:00:00.000Z'));
    expect(expired).toHaveLength(1);
    expect(expired[0].kick_user_id).toBe('u4');
  });

  test('rejeita datas inválidas', () => {
    expect(() => {
      subscriptionsRepository.upsertFromEvent({
        broadcasterUserId: 'b3',
        kickUserId: 'u5',
        kickUsername: 'user-five',
        subscriptionType: 'direct',
        startedAtIso: 'invalid-date',
        expiresAtIso: '2026-09-01T00:00:00.000Z',
        lastEventMessageId: 'evt-7',
        updatedAtMs: 1500,
      });
    }).toThrow(/data ISO válida/);
  });

  test('idempotência no repositório de eventos por event_message_id', () => {
    const first = webhookEventsRepository.registerProcessedEvent({
      eventMessageId: 'evt-idem-1',
      eventSubscriptionId: 'sub-1',
      eventType: 'channel.subscription.new',
      eventVersion: '1',
      eventTimestamp: '2026-08-01T00:00:00.000Z',
      receivedAtMs: 100,
      processedAtMs: 110,
    });

    const second = webhookEventsRepository.registerProcessedEvent({
      eventMessageId: 'evt-idem-1',
      eventSubscriptionId: 'sub-1',
      eventType: 'channel.subscription.new',
      eventVersion: '1',
      eventTimestamp: '2026-08-01T00:00:00.000Z',
      receivedAtMs: 100,
      processedAtMs: 110,
    });

    expect(first).toEqual({ recorded: true, reason: null });
    expect(second).toEqual({ recorded: false, reason: 'duplicate' });
    expect(webhookEventsRepository.hasProcessed('evt-idem-1')).toBe(true);
  });
});
