const http = require('http');

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const {
  startKickHttpServer,
  stopKickHttpServer,
  getKickHttpServerInstance,
} = require('../src/services/kickHttpServer');

function createDependencies(overrides = {}) {
  return {
    config: {
      kickPort: 0,
      kickEnabled: true,
      kickHttpMaxBodyBytes: 1048576,
      kickHttpBodyTimeoutMs: 10000,
      kickHttpMaxUrlLength: 8192,
      ...(overrides.config || {}),
    },
    kickAuthService:
      overrides.kickAuthService || {
        completeOAuthCallback: jest.fn().mockResolvedValue({ kickUsername: 'ok' }),
      },
    kickWebhookSignatureService:
      overrides.kickWebhookSignatureService || {
        validateRequest: jest.fn().mockResolvedValue({ ok: false, reason: 'missing_headers' }),
      },
    kickSubscriptionEventService:
      overrides.kickSubscriptionEventService || {
        processEvent: jest.fn(),
      },
    subscriberRoleAutoSyncService:
      overrides.subscriberRoleAutoSyncService || {
        syncAfterEligibilityChange: jest.fn(),
      },
    logger: overrides.logger || { info: jest.fn(), warn: jest.fn() },
  };
}

async function startServer(overrides = {}) {
  const dependencies = createDependencies(overrides);
  const startResult = await startKickHttpServer(dependencies);
  expect(startResult.started).toBe(true);

  const instance = getKickHttpServerInstance();
  const address = instance.address();

  return {
    dependencies,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function httpRequest({ method, port, path, headers, writes, endBody, skipEnd }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        family: 4,
        port,
        path,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );

    req.on('error', reject);

    for (const chunk of writes || []) {
      req.write(chunk);
    }

    if (endBody !== undefined) {
      req.end(endBody);
      return;
    }

    if (!skipEnd) {
      req.end();
    }
  });
}

describe('kickHttpServer real HTTP rejection delivery', () => {
  afterEach(async () => {
    await stopKickHttpServer();
  });

  test('payload 1048577 retorna 413 sem ECONNRESET/UND_ERR_SOCKET e sem processamento interno', async () => {
    const validateRequest = jest.fn();
    const processEvent = jest.fn();

    const { baseUrl } = await startServer({
      kickWebhookSignatureService: { validateRequest },
      kickSubscriptionEventService: { processEvent },
    });

    const port = Number(new URL(baseUrl).port);
    const result = await httpRequest({
      method: 'POST',
      port,
      path: '/kick/webhooks',
      headers: { 'content-type': 'application/json' },
      endBody: 'a'.repeat(1048577),
    });

    expect(result.statusCode).toBe(413);
    expect(result.body).toBe('Payload Too Large');
    expect(validateRequest).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  test('Content-Length acima do limite recebe 413 real', async () => {
    const validateRequest = jest.fn();

    const { baseUrl } = await startServer({
      kickWebhookSignatureService: { validateRequest },
      config: { kickHttpMaxBodyBytes: 1024 },
    });

    const port = Number(new URL(baseUrl).port);
    const result = await httpRequest({
      method: 'POST',
      port,
      path: '/kick/webhooks',
      headers: {
        'content-type': 'application/json',
        'content-length': '1025',
      },
    });

    expect(result.statusCode).toBe(413);
    expect(result.body).toBe('Payload Too Large');
    expect(validateRequest).not.toHaveBeenCalled();
  });

  test('overflow por chunks sem Content-Length recebe 413 real', async () => {
    const validateRequest = jest.fn();

    const { baseUrl } = await startServer({
      kickWebhookSignatureService: { validateRequest },
      config: { kickHttpMaxBodyBytes: 8 },
    });

    const port = Number(new URL(baseUrl).port);
    const result = await httpRequest({
      method: 'POST',
      port,
      path: '/kick/webhooks',
      headers: { 'content-type': 'application/json' },
      writes: [Buffer.from('1234', 'utf8'), Buffer.from('56789', 'utf8')],
      endBody: '',
    });

    expect(result.statusCode).toBe(413);
    expect(result.body).toBe('Payload Too Large');
    expect(validateRequest).not.toHaveBeenCalled();
  });

  test('apos 413, /health continua 200 e requisição seguinte normal funciona', async () => {
    const validateRequest = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          eventMessageId: 'evt-1',
          eventSubscriptionId: 'sub-1',
          eventSignature: 'sig',
          eventTimestamp: '2026-08-06T00:00:00.000Z',
          eventType: 'channel.subscription.new',
          eventVersion: '1',
        },
      });

    const processEvent = jest.fn().mockReturnValue({ status: 'processed', appliedCount: 1 });

    const { baseUrl } = await startServer({
      kickWebhookSignatureService: { validateRequest },
      kickSubscriptionEventService: { processEvent },
      config: { kickHttpMaxBodyBytes: 16 },
    });

    const port = Number(new URL(baseUrl).port);
    const rejected = await httpRequest({
      method: 'POST',
      port,
      path: '/kick/webhooks',
      headers: { 'content-type': 'application/json' },
      endBody: 'a'.repeat(17),
    });

    expect(rejected.statusCode).toBe(413);

    const health = await httpRequest({ method: 'GET', port, path: '/health' });
    expect(health.statusCode).toBe(200);

    const accepted = await httpRequest({
      method: 'POST',
      port,
      path: '/kick/webhooks',
      headers: { 'content-type': 'application/json' },
      endBody: '{"ok":true}',
    });

    expect(accepted.statusCode).toBe(204);
    expect(processEvent).toHaveBeenCalledTimes(1);
  });

  test('timeout de body recebe 408 real sem processamento interno', async () => {
    const validateRequest = jest.fn();
    const processEvent = jest.fn();

    const { baseUrl } = await startServer({
      kickWebhookSignatureService: { validateRequest },
      kickSubscriptionEventService: { processEvent },
      config: { kickHttpBodyTimeoutMs: 25 },
    });

    const port = Number(new URL(baseUrl).port);
    const pending = httpRequest({
      method: 'POST',
      port,
      path: '/kick/webhooks',
      headers: { 'content-type': 'application/json' },
      writes: [Buffer.from('{"partial":', 'utf8')],
      skipEnd: true,
    });

    const result = await pending;

    expect(result.statusCode).toBe(408);
    expect(result.body).toBe('Request Timeout');
    expect(validateRequest).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  test('URL longa recebe 414 real sem chamar OAuth', async () => {
    const completeOAuthCallback = jest.fn();

    const { baseUrl } = await startServer({
      kickAuthService: { completeOAuthCallback },
      config: { kickHttpMaxUrlLength: 40 },
    });

    const port = Number(new URL(baseUrl).port);
    const longPath = `/kick/callback?code=${'c'.repeat(200)}&state=${'s'.repeat(200)}`;
    const response = await httpRequest({ method: 'GET', port, path: longPath });

    expect(response.statusCode).toBe(414);
    expect(response.body).toBe('URI Too Long');
    expect(completeOAuthCallback).not.toHaveBeenCalled();
  });

  test('shutdown encerra conexão pendente em leitura de forma controlada', async () => {
    const { baseUrl } = await startServer({
      config: { kickHttpBodyTimeoutMs: 10000 },
    });

    const port = Number(new URL(baseUrl).port);

    const req = http.request({
      method: 'POST',
      host: '127.0.0.1',
      family: 4,
      port,
      path: '/kick/webhooks',
      headers: { 'content-type': 'application/json' },
    });

    req.on('error', () => {
      // Expected if shutdown closes a pending client socket.
    });

    req.write('{"pending":');

    const stopPromise = stopKickHttpServer();
    await expect(stopPromise).resolves.toBeUndefined();

    req.destroy();
  });
});
