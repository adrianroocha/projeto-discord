const http = require('http');

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const {
  createRequestHandler,
  startKickHttpServer,
  stopKickHttpServer,
  mapCallbackError,
} = require('../src/services/kickHttpServer');

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

describe('kickHttpServer', () => {
  afterEach(async () => {
    await stopKickHttpServer();
  });

  test('rota /health responde 200 com json', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickAuthService: { completeOAuthCallback: jest.fn() },
    });

    const req = { method: 'GET', url: '/health' };
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', service: 'kick-oauth' });
  });

  test('rota desconhecida retorna 404', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickAuthService: { completeOAuthCallback: jest.fn() },
    });

    const req = { method: 'GET', url: '/nao-existe' };
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Not Found');
  });

  test('callback sem code retorna 400', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickAuthService: {
        completeOAuthCallback: jest.fn().mockRejectedValue({ code: 'MISSING_CODE', category: 'missing_code' }),
      },
      logger: { warn: jest.fn() },
    });

    const req = { method: 'GET', url: '/kick/callback?state=abc' };
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Parâmetros inválidos');
  });

  test('callback sem state retorna 400', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickAuthService: {
        completeOAuthCallback: jest.fn().mockRejectedValue({ code: 'MISSING_STATE', category: 'missing_state' }),
      },
      logger: { warn: jest.fn() },
    });

    const req = { method: 'GET', url: '/kick/callback?code=abc' };
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Parâmetros inválidos');
  });

  test('callback com conflito retorna 409', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickAuthService: {
        completeOAuthCallback: jest.fn().mockRejectedValue({
          code: 'KICK_ACCOUNT_CONFLICT',
          category: 'kick_account_conflict',
        }),
      },
      logger: { warn: jest.fn() },
    });

    const req = { method: 'GET', url: '/kick/callback?code=abc&state=xyz' };
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('Conta Kick já vinculada');
  });

  test('servidor inicia apenas uma vez', async () => {
    const info = await startKickHttpServer({
      config: { kickPort: 0, kickEnabled: false },
      kickAuthService: {
        completeOAuthCallback: jest.fn().mockResolvedValue({
          kickUsername: 'ok',
        }),
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    const second = await startKickHttpServer({
      config: { kickPort: 0, kickEnabled: false },
      kickAuthService: {
        completeOAuthCallback: jest.fn().mockResolvedValue({
          kickUsername: 'ok',
        }),
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    expect(info.started).toBe(true);
    expect(second.started).toBe(false);

    const serverInstance = require('../src/services/kickHttpServer').getKickHttpServerInstance();
    const address = serverInstance.address();
    expect(address.address).toBe('127.0.0.1');
  });

  test('mapCallbackError trata rate limit e indisponibilidade', () => {
    expect(mapCallbackError({ httpStatus: 429 }).statusCode).toBe(429);
    expect(mapCallbackError({ httpStatus: 503 }).statusCode).toBe(502);
  });

  test('callback de sucesso responde html amigável', async () => {
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      kickAuthService: {
        completeOAuthCallback: jest.fn().mockResolvedValue({ kickUsername: 'kick-ok' }),
      },
    });

    const req = { method: 'GET', url: '/kick/callback?code=ok&state=ok' };
    const res = createMockResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Conta Kick vinculada com sucesso');
    expect(res.body).toContain('kick-ok');
  });

  test('rota /health funciona em servidor real via localhost', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const started = await startKickHttpServer({
      config: { kickPort: 0, kickEnabled: true },
      kickAuthService: { completeOAuthCallback: jest.fn() },
      logger,
    });

    expect(started.started).toBe(true);

    const serverInstance = require('../src/services/kickHttpServer').getKickHttpServerInstance();
    const address = serverInstance.address();
    expect(address.address).toBe('127.0.0.1');

    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          method: 'GET',
          host: 'localhost',
          family: 4,
          port: address.port,
          path: '/health',
        },
        (res) => {
          let chunks = '';
          res.on('data', (chunk) => {
            chunks += chunk;
          });
          res.on('end', () => resolve({ statusCode: res.statusCode, body: chunks }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(body.statusCode).toBe(200);
    expect(JSON.parse(body.body)).toEqual({ status: 'ok', service: 'kick-oauth' });
  });

  test('callback OAuth durante shutdown retorna 503', async () => {
    const completeOAuthCallback = jest.fn();
    const handler = createRequestHandler({
      config: { kickPort: 3000 },
      applicationLifecycleService: {
        isShuttingDown: () => true,
      },
      kickAuthService: { completeOAuthCallback },
    });

    const req = { method: 'GET', url: '/kick/callback?code=abc&state=xyz' };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(completeOAuthCallback).not.toHaveBeenCalled();
  });
});
