const { Readable } = require('stream');
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';
const { createRequestHandler } = require('../src/services/kickHttpServer');

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
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
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
      kickSubscriptionEventService: {
        processEvent: jest.fn().mockReturnValue({ status: 'processed', appliedCount: 1 }),
      },
    });

    const req = createPostRequest('/kick/webhooks', { any: 'header' }, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
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
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
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

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
  });

  test('evento de outro broadcaster retorna 204 sem erro', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
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

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
  });

  test('retorna 503 quando KICK_BROADCASTER_USER_ID está ausente', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
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

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
  });

  test('falha interna no processamento retorna 500 para retry', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
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
      logger: { warn: jest.fn() },
    });

    const req = createPostRequest('/kick/webhooks', {}, '{"ok":true}');
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
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
