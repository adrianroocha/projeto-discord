process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const { createSubscriberEligibilityService } = require('../src/services/subscriberEligibilityService');
const { createTestContext, getDb } = require('./helpers/testDatabase');

describe('subscriberEligibilityService', () => {
  function createService(overrides = {}) {
    const kickAccountsRepository =
      overrides.kickAccountsRepository || {
        findByDiscordId: jest.fn().mockReturnValue(null),
      };

    const kickSubscriptionsRepository =
      overrides.kickSubscriptionsRepository || {
        findByBroadcasterAndKickUser: jest.fn().mockReturnValue(null),
      };

    const manualSubGrantService =
      overrides.manualSubGrantService || {
        hasActiveGrant: jest.fn().mockReturnValue(false),
        getStatus: jest.fn().mockReturnValue({ active: null }),
      };

    const service = createSubscriberEligibilityService({
      config: {
        kickBroadcasterUserId: '75942843',
        ...(overrides.config || {}),
      },
      kickAccountsRepository,
      kickSubscriptionsRepository,
      manualSubGrantService,
      now: overrides.now || (() => 1000),
    });

    return {
      service,
      kickAccountsRepository,
      kickSubscriptionsRepository,
      manualSubGrantService,
    };
  }

  test('sem vínculo e sem manual', () => {
    const { service } = createService();
    const result = service.getEligibility('discord-1', 2000);

    expect(result.eligible).toBe(false);
    expect(result.sources.kick.linked).toBe(false);
    expect(result.sources.manual.active).toBe(false);
  });

  test('sem vínculo com manual ativa', () => {
    const { service } = createService({
      manualSubGrantService: {
        hasActiveGrant: jest.fn().mockReturnValue(true),
        getStatus: jest.fn().mockReturnValue({
          active: {
            reason: 'Pix',
            grantedByDiscordId: 'admin-1',
            grantedAtMs: 100,
            expiresAtMs: null,
          },
        }),
      },
    });

    const result = service.getEligibility('discord-2', 2000);
    expect(result.eligible).toBe(true);
    expect(result.sources.kick.active).toBe(false);
    expect(result.sources.manual.active).toBe(true);
  });

  test('vínculo sem subscription', () => {
    const { service } = createService({
      kickAccountsRepository: {
        findByDiscordId: jest.fn().mockReturnValue({
          kick_user_id: 'kick-3',
          kick_username: 'user3',
        }),
      },
    });

    const result = service.getEligibility('discord-3', 2000);
    expect(result.sources.kick.linked).toBe(true);
    expect(result.sources.kick.observed).toBe(false);
    expect(result.sources.kick.active).toBe(false);
    expect(result.eligible).toBe(false);
  });

  test('Kick direta ativa', () => {
    const { service } = createService({
      kickAccountsRepository: {
        findByDiscordId: jest.fn().mockReturnValue({
          kick_user_id: 'kick-4',
          kick_username: 'user4',
        }),
      },
      kickSubscriptionsRepository: {
        findByBroadcasterAndKickUser: jest.fn().mockReturnValue({
          started_at_ms: 100,
          expires_at_ms: 3000,
          subscription_type: 'direct',
        }),
      },
    });

    const result = service.getEligibility('discord-4', 2000);
    expect(result.sources.kick.active).toBe(true);
    expect(result.sources.kick.subscriptionType).toBe('direct');
    expect(result.eligible).toBe(true);
  });

  test('Kick presenteada ativa', () => {
    const { service } = createService({
      kickAccountsRepository: {
        findByDiscordId: jest.fn().mockReturnValue({
          kick_user_id: 'kick-5',
          kick_username: 'user5',
        }),
      },
      kickSubscriptionsRepository: {
        findByBroadcasterAndKickUser: jest.fn().mockReturnValue({
          started_at_ms: 100,
          expires_at_ms: 3000,
          subscription_type: 'gifted',
        }),
      },
    });

    const result = service.getEligibility('discord-5', 2000);
    expect(result.sources.kick.active).toBe(true);
    expect(result.sources.kick.subscriptionType).toBe('gifted');
    expect(result.eligible).toBe(true);
  });

  test('Kick expirada', () => {
    const { service } = createService({
      kickAccountsRepository: {
        findByDiscordId: jest.fn().mockReturnValue({
          kick_user_id: 'kick-6',
          kick_username: 'user6',
        }),
      },
      kickSubscriptionsRepository: {
        findByBroadcasterAndKickUser: jest.fn().mockReturnValue({
          started_at_ms: 100,
          expires_at_ms: 1000,
          subscription_type: 'direct',
        }),
      },
    });

    const result = service.getEligibility('discord-6', 2000);
    expect(result.sources.kick.observed).toBe(true);
    expect(result.sources.kick.active).toBe(false);
    expect(result.eligible).toBe(false);
  });

  test('manual ativa', () => {
    const { service } = createService({
      manualSubGrantService: {
        hasActiveGrant: jest.fn().mockReturnValue(true),
        getStatus: jest.fn().mockReturnValue({
          active: {
            reason: 'Cortesia',
            grantedByDiscordId: 'admin-2',
            grantedAtMs: 200,
            expiresAtMs: 5000,
          },
        }),
      },
    });

    const result = service.getEligibility('discord-7', 2000);
    expect(result.sources.manual.active).toBe(true);
    expect(result.eligible).toBe(true);
  });

  test('manual expirada', () => {
    const { service } = createService({
      manualSubGrantService: {
        hasActiveGrant: jest.fn().mockReturnValue(false),
        getStatus: jest.fn().mockReturnValue({ active: null }),
      },
    });

    const result = service.getEligibility('discord-8', 2000);
    expect(result.sources.manual.active).toBe(false);
    expect(result.eligible).toBe(false);
  });

  test('manual revogada', () => {
    const { service } = createService({
      manualSubGrantService: {
        hasActiveGrant: jest.fn().mockReturnValue(false),
        getStatus: jest.fn().mockReturnValue({ active: null }),
      },
    });

    const result = service.getEligibility('discord-9', 2000);
    expect(result.sources.manual.active).toBe(false);
    expect(result.eligible).toBe(false);
  });

  test('Kick e manual ativas', () => {
    const { service } = createService({
      kickAccountsRepository: {
        findByDiscordId: jest.fn().mockReturnValue({
          kick_user_id: 'kick-10',
          kick_username: 'user10',
        }),
      },
      kickSubscriptionsRepository: {
        findByBroadcasterAndKickUser: jest.fn().mockReturnValue({
          started_at_ms: 100,
          expires_at_ms: 3000,
          subscription_type: 'direct',
        }),
      },
      manualSubGrantService: {
        hasActiveGrant: jest.fn().mockReturnValue(true),
        getStatus: jest.fn().mockReturnValue({
          active: {
            reason: 'Pix',
            grantedByDiscordId: 'admin-3',
            grantedAtMs: 300,
            expiresAtMs: null,
          },
        }),
      },
    });

    const result = service.getEligibility('discord-10', 2000);
    expect(result.sources.kick.active).toBe(true);
    expect(result.sources.manual.active).toBe(true);
    expect(result.eligible).toBe(true);
  });

  test('Kick expirada e manual ativa', () => {
    const { service } = createService({
      kickAccountsRepository: {
        findByDiscordId: jest.fn().mockReturnValue({
          kick_user_id: 'kick-11',
          kick_username: 'user11',
        }),
      },
      kickSubscriptionsRepository: {
        findByBroadcasterAndKickUser: jest.fn().mockReturnValue({
          started_at_ms: 100,
          expires_at_ms: 1000,
          subscription_type: 'direct',
        }),
      },
      manualSubGrantService: {
        hasActiveGrant: jest.fn().mockReturnValue(true),
        getStatus: jest.fn().mockReturnValue({
          active: {
            reason: 'Pix',
            grantedByDiscordId: 'admin-4',
            grantedAtMs: 300,
            expiresAtMs: null,
          },
        }),
      },
    });

    const result = service.getEligibility('discord-11', 2000);
    expect(result.sources.kick.active).toBe(false);
    expect(result.sources.manual.active).toBe(true);
    expect(result.eligible).toBe(true);
  });

  test('Kick ativa e manual inativa', () => {
    const { service } = createService({
      kickAccountsRepository: {
        findByDiscordId: jest.fn().mockReturnValue({
          kick_user_id: 'kick-12',
          kick_username: 'user12',
        }),
      },
      kickSubscriptionsRepository: {
        findByBroadcasterAndKickUser: jest.fn().mockReturnValue({
          started_at_ms: 100,
          expires_at_ms: 3000,
          subscription_type: 'gifted',
        }),
      },
    });

    const result = service.getEligibility('discord-12', 2000);
    expect(result.sources.kick.active).toBe(true);
    expect(result.sources.manual.active).toBe(false);
    expect(result.eligible).toBe(true);
  });

  test('expires_at igual a nowMs deve ser expirado', () => {
    const { service } = createService({
      kickAccountsRepository: {
        findByDiscordId: jest.fn().mockReturnValue({
          kick_user_id: 'kick-13',
          kick_username: 'user13',
        }),
      },
      kickSubscriptionsRepository: {
        findByBroadcasterAndKickUser: jest.fn().mockReturnValue({
          started_at_ms: 100,
          expires_at_ms: 2000,
          subscription_type: 'direct',
        }),
      },
    });

    const result = service.getEligibility('discord-13', 2000);
    expect(result.sources.kick.active).toBe(false);
    expect(result.eligible).toBe(false);
  });

  test('broadcaster ausente com manual ativa', () => {
    const { service } = createService({
      config: {
        kickBroadcasterUserId: '',
      },
      manualSubGrantService: {
        hasActiveGrant: jest.fn().mockReturnValue(true),
        getStatus: jest.fn().mockReturnValue({
          active: {
            reason: 'Pix',
            grantedByDiscordId: 'admin-5',
            grantedAtMs: 300,
            expiresAtMs: 7000,
          },
        }),
      },
    });

    const result = service.getEligibility('discord-14', 2000);
    expect(result.sources.kick.observed).toBe(false);
    expect(result.sources.manual.active).toBe(true);
    expect(result.eligible).toBe(true);
  });

  test('follow existente sem subscription não concede elegibilidade', async () => {
    const context = await createTestContext({ kickBroadcasterUserId: 'b1' });
    const db = getDb(context.sqliteClient);

    db.prepare(
      'INSERT INTO kick_accounts (discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run('discord-follow', 'kick-follow', 'follow-user', 1_000, 1_000);

    db.prepare(
      'INSERT INTO kick_follow_events (event_message_id, broadcaster_user_id, follower_user_id, follower_username, followed_at_ms, received_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('evt-follow-existing', 'b1', 'kick-follow', 'follow-user', 1_500, 1_550);

    const realService = require('../src/services/subscriberEligibilityService');
    const result = realService.getEligibility('discord-follow', 2_000);

    expect(result.sources.kick.linked).toBe(true);
    expect(result.sources.kick.observed).toBe(false);
    expect(result.sources.kick.active).toBe(false);
    expect(result.eligible).toBe(false);

    await context.cleanup();
  });

  test('consulta sem alteração de banco', async () => {
    const context = await createTestContext({ kickBroadcasterUserId: 'b2' });
    const db = getDb(context.sqliteClient);

    db.prepare(
      'INSERT INTO kick_accounts (discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run('discord-read-only', 'kick-read-only', 'readonly-user', 1_000, 1_000);

    const beforeWebhook = db.prepare('SELECT COUNT(1) AS count FROM kick_webhook_events').get().count;
    const beforeFollow = db.prepare('SELECT COUNT(1) AS count FROM kick_follow_events').get().count;
    const beforeSubscriptions = db.prepare('SELECT COUNT(1) AS count FROM kick_subscriptions').get().count;

    const realService = require('../src/services/subscriberEligibilityService');
    realService.getEligibility('discord-read-only', 2_000);

    const afterWebhook = db.prepare('SELECT COUNT(1) AS count FROM kick_webhook_events').get().count;
    const afterFollow = db.prepare('SELECT COUNT(1) AS count FROM kick_follow_events').get().count;
    const afterSubscriptions = db.prepare('SELECT COUNT(1) AS count FROM kick_subscriptions').get().count;

    expect(afterWebhook).toBe(beforeWebhook);
    expect(afterFollow).toBe(beforeFollow);
    expect(afterSubscriptions).toBe(beforeSubscriptions);

    await context.cleanup();
  });

  test('nenhum acesso real à Kick ou Discord', () => {
    const originalFetch = global.fetch;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    try {
      const { service } = createService();
      service.getEligibility('discord-17', 2000);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
