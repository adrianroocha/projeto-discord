const { Readable } = require('stream');
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';
const { createRequestHandler } = require('../src/services/kickHttpServer');

function createWebhookDependencies(overrides = {}) {
  const kickWebhookSignatureService =
    overrides.kickWebhookSignatureService || {
      validateRequest: jest.fn().mockResolvedValue({
        ok: true,
        headers: {
          eventMessageId: 'evt-default',
          eventSubscriptionId: 'sub-default',
          eventType: 'channel.subscription.new',
          eventVersion: '1',
          eventTimestamp: '2026-08-06T00:00:00.000Z',
        },
      }),
    };

  const kickSubscriptionEventService =
    overrides.kickSubscriptionEventService || {
      processEvent: jest.fn().mockReturnValue({ status: 'processed', appliedCount: 1 }),
    };

  const kickAccountsRepository =
    overrides.kickAccountsRepository || {
      findByKickUserId: jest.fn().mockReturnValue({ discord_id: 'discord-1' }),
    };

  const subscriberRoleAutoSyncService =
    overrides.subscriberRoleAutoSyncService || {
      syncAfterEligibilityChange: jest.fn().mockResolvedValue({ status: 'synced' }),
    };

  return {
    config: { kickPort: 3000 },
    kickWebhookSignatureService,
    kickSubscriptionEventService,
    kickAccountsRepository,
    subscriberRoleAutoSyncService,
    discordClient: {},
    logger: { info: jest.fn(), warn: jest.fn() },
  };
}

function createMockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk = '') {
      this.body += chunk;
    },
  };
}

function createPostRequest(url, headers, body) {
  const req = new Readable({
    read() {
      this.push(Buffer.from(body, 'utf8'));
      this.push(null);
    },
  });

  req.method = 'POST';
  req.url = url;
  req.headers = headers;
  return req;
}

describe('kickHttpServer webhook route', () => {
  test('webhook válido processado retorna 204', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-1',
            eventSubscriptionId: 'sub-1',
            eventType: 'channel.subscription.new',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest('/kick/webhooks', { any: 'header' }, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).toHaveBeenCalledTimes(0);
  });

  test('new sincroniza usuário vinculado', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-new-1',
            eventSubscriptionId: 'sub-new-1',
            eventType: 'channel.subscription.new',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickAccountsRepository: {
        findByKickUserId: jest.fn().mockReturnValue({ discord_id: 'discord-new' }),
      },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest(
      '/kick/webhooks',
      {},
      JSON.stringify({
        subscriber: { user_id: 'kick-new' },
      }),
    );
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(dependencies.kickAccountsRepository.findByKickUserId).toHaveBeenCalledWith('kick-new');
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'discord-new',
        triggerType: 'kick_subscription_new',
      }),
    );
  });

  test('renewal sincroniza usuário vinculado', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-ren-1',
            eventSubscriptionId: 'sub-ren-1',
            eventType: 'channel.subscription.renewal',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickAccountsRepository: {
        findByKickUserId: jest.fn().mockReturnValue({ discord_id: 'discord-ren' }),
      },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest(
      '/kick/webhooks',
      {},
      JSON.stringify({
        subscriber: { user_id: 'kick-ren' },
      }),
    );
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'discord-ren',
        triggerType: 'kick_subscription_renewal',
      }),
    );
  });

  test('gift sincroniza múltiplos giftees vinculados', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-gift-1',
            eventSubscriptionId: 'sub-gift-1',
            eventType: 'channel.subscription.gifts',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickAccountsRepository: {
        findByKickUserId: jest.fn((kickUserId) => {
          if (kickUserId === 'gift-1') {
            return { discord_id: 'discord-gift-1' };
          }
          if (kickUserId === 'gift-2') {
            return { discord_id: 'discord-gift-2' };
          }
          return null;
        }),
      },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest(
      '/kick/webhooks',
      {},
      JSON.stringify({
        giftees: [{ user_id: 'gift-1' }, { user_id: 'gift-2' }],
      }),
    );
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).toHaveBeenCalledTimes(2);
  });

  test('giftee sem vínculo não é erro', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-gift-2',
            eventSubscriptionId: 'sub-gift-2',
            eventType: 'channel.subscription.gifts',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickAccountsRepository: {
        findByKickUserId: jest.fn().mockReturnValue(null),
      },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest(
      '/kick/webhooks',
      {},
      JSON.stringify({
        giftees: [{ user_id: 'gift-unlinked' }],
      }),
    );
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).not.toHaveBeenCalled();
  });

  test('assinatura inválida retorna 401', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({ ok: false, reason: 'invalid_signature' }),
      },
      kickSubscriptionEventService: { processEvent: jest.fn() },
    });

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  test('headers ausentes retorna 400', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: false,
          reason: 'missing_headers',
          missingHeaders: ['kick-event-message-id'],
        }),
      },
      kickSubscriptionEventService: { processEvent: jest.fn() },
    });

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  test('json inválido retorna 400', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-2',
            eventSubscriptionId: 'sub-2',
            eventType: 'channel.subscription.new',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickSubscriptionEventService: { processEvent: jest.fn() },
    });

    const req = createPostRequest('/kick/webhooks', {}, '{invalid-json');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  test('evento duplicado retorna 204', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-3',
            eventSubscriptionId: 'sub-3',
            eventType: 'channel.subscription.new',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickSubscriptionEventService: {
        processEvent: jest.fn().mockReturnValue({ status: 'duplicate', appliedCount: 0 }),
      },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).not.toHaveBeenCalled();
  });

  test('evento de outro broadcaster retorna 204 sem erro', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-4',
            eventSubscriptionId: 'sub-4',
            eventType: 'channel.subscription.new',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickSubscriptionEventService: {
        processEvent: jest.fn().mockReturnValue({ status: 'ignored_other_broadcaster', appliedCount: 0 }),
      },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).not.toHaveBeenCalled();
  });

  test('channel.followed nunca sincroniza cargo', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-follow-1',
            eventSubscriptionId: 'sub-follow-1',
            eventType: 'channel.followed',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickSubscriptionEventService: {
        processEvent: jest.fn().mockReturnValue({ status: 'processed', appliedCount: 1 }),
      },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest('/kick/webhooks', {}, JSON.stringify({ follower: { user_id: 'f1' } }));
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).not.toHaveBeenCalled();
  });

  test('retorna 503 quando KICK_BROADCASTER_USER_ID está ausente', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-4b',
            eventSubscriptionId: 'sub-4b',
            eventType: 'channel.subscription.new',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickSubscriptionEventService: {
        processEvent: jest.fn().mockReturnValue({ status: 'webhook_disabled_unconfigured', appliedCount: 0 }),
      },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).not.toHaveBeenCalled();
  });

  test('falha interna no processamento retorna 500 para retry', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-5',
            eventSubscriptionId: 'sub-5',
            eventType: 'channel.subscription.new',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickSubscriptionEventService: {
        processEvent: jest.fn().mockImplementation(() => {
          throw new Error('db down');
        }),
      },
      logger: { warn: jest.fn(), info: jest.fn() },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).not.toHaveBeenCalled();
  });

  test('falha de sincronização de cargo mantém resposta 204 após persistência', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-sync-fail-1',
            eventSubscriptionId: 'sub-sync-fail-1',
            eventType: 'channel.subscription.new',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickAccountsRepository: {
        findByKickUserId: jest.fn().mockReturnValue({ discord_id: 'discord-sync-fail' }),
      },
      subscriberRoleAutoSyncService: {
        syncAfterEligibilityChange: jest.fn().mockResolvedValue({ status: 'warning' }),
      },
      logger: { warn: jest.fn(), info: jest.fn() },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest(
      '/kick/webhooks',
      {},
      JSON.stringify({
        subscriber: { user_id: 'kick-sync-fail' },
      }),
    );
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange).toHaveBeenCalledTimes(1);
  });

  test('exceção inesperada durante sync de cargo ainda retorna 204 após persistência', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-sync-throw-1',
            eventSubscriptionId: 'sub-sync-throw-1',
            eventType: 'channel.subscription.new',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickAccountsRepository: {
        findByKickUserId: jest.fn().mockReturnValue({ discord_id: 'discord-sync-throw' }),
      },
      subscriberRoleAutoSyncService: {
        syncAfterEligibilityChange: jest.fn().mockRejectedValue(new Error('discord down')),
      },
      logger: { warn: jest.fn(), info: jest.fn() },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest(
      '/kick/webhooks',
      {},
      JSON.stringify({
        subscriber: { user_id: 'kick-sync-throw' },
      }),
    );
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
  });

  test('ordem garante processEvent antes da sincronização de cargo', async () => {
    const dependencies = createWebhookDependencies({
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockResolvedValue({
          ok: true,
          headers: {
            eventMessageId: 'evt-order-1',
            eventSubscriptionId: 'sub-order-1',
            eventType: 'channel.subscription.new',
            eventVersion: '1',
            eventTimestamp: '2026-08-06T00:00:00.000Z',
          },
        }),
      },
      kickSubscriptionEventService: {
        processEvent: jest.fn().mockReturnValue({ status: 'processed', appliedCount: 1 }),
      },
      kickAccountsRepository: {
        findByKickUserId: jest.fn().mockReturnValue({ discord_id: 'discord-order-1' }),
      },
    });
    const handler = createRequestHandler(dependencies);

    const req = createPostRequest(
      '/kick/webhooks',
      {},
      JSON.stringify({
        subscriber: { user_id: 'kick-order-1' },
      }),
    );
    const res = createMockResponse();
    await handler(req, res);

    const processOrder = dependencies.kickSubscriptionEventService.processEvent.mock.invocationCallOrder[0];
    const syncOrder =
      dependencies.subscriberRoleAutoSyncService.syncAfterEligibilityChange.mock.invocationCallOrder[0];
    expect(processOrder).toBeLessThan(syncOrder);
    expect(res.statusCode).toBe(204);
  });

  test('falha para obter chave pública retorna 500', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickWebhookSignatureService: {
        validateRequest: jest.fn().mockRejectedValue(new Error('key unavailable')),
      },
      kickSubscriptionEventService: { processEvent: jest.fn() },
      logger: { warn: jest.fn() },
    });

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
  });

  test('/health e /kick/callback continuam funcionando', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickAuthService: {
        completeOAuthCallback: jest.fn().mockResolvedValue({ kickUsername: 'kick-ok' }),
      },
      kickWebhookSignatureService: { validateRequest: jest.fn() },
      kickSubscriptionEventService: { processEvent: jest.fn() },
    });

    const healthRes = createMockResponse();
    await handler({ method: 'GET', url: '/health' }, healthRes);

    const callbackRes = createMockResponse();
    await handler({ method: 'GET', url: '/kick/callback?code=ok&state=ok' }, callbackRes);

    expect(healthRes.statusCode).toBe(200);
    expect(callbackRes.statusCode).toBe(200);
    expect(callbackRes.body).toContain('Conta Kick vinculada com sucesso');
  });
});
