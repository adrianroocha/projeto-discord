process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const {
  createKickEventSubscriptionService,
  DESIRED_KICK_EVENTS,
} = require('../src/services/kickEventSubscriptionService');

describe('kickEventSubscriptionService', () => {
  function createService(overrides = {}) {
    const logger =
      overrides.logger ||
      {
        info: jest.fn(),
        warn: jest.fn(),
      };

    const kickApiService =
      overrides.kickApiService ||
      {
        listEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          subscriptions: [],
          diagnostics: [],
        }),
        createEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          results: DESIRED_KICK_EVENTS.map((event) => ({
            name: event.name,
            version: event.version,
            subscriptionId: `sub-${event.name}`,
            error: null,
            confirmed: true,
          })),
          diagnostics: DESIRED_KICK_EVENTS.map((event) => ({
            name: event.name,
            version: event.version,
            subscriptionIdPresent: true,
            error: null,
          })),
        }),
      };

    const kickAppTokenService =
      overrides.kickAppTokenService ||
      {
        getAccessToken: jest.fn().mockResolvedValue('app-token-123'),
        invalidateToken: jest.fn(),
      };

    const service = createKickEventSubscriptionService({
      config: {
        kickClientId: 'client-id',
        kickClientSecret: 'client-secret',
        kickBroadcasterUserId: '75942843',
        ...overrides.config,
      },
      logger,
      kickApiService,
      kickAppTokenService,
    });

    return {
      service,
      kickApiService,
      kickAppTokenService,
      logger,
    };
  }

  test('consulta subscriptions existentes com broadcaster_user_id', async () => {
    const { service, kickApiService } = createService();

    await service.syncDesiredEvents();

    expect(kickApiService.listEventSubscriptions).toHaveBeenCalledWith({
      accessToken: 'app-token-123',
      broadcasterUserId: 75942843,
    });
  });

  test('quando nenhum evento existe, cria todos os eventos desejados', async () => {
    const { service, kickApiService } = createService();

    const result = await service.syncDesiredEvents();

    expect(kickApiService.createEventSubscriptions).toHaveBeenCalledTimes(1);
    const payload = kickApiService.createEventSubscriptions.mock.calls[0][0];

    expect(payload.events).toEqual(DESIRED_KICK_EVENTS);
    expect(result.created).toHaveLength(DESIRED_KICK_EVENTS.length);
    expect(result.alreadyActive).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  test('quando alguns eventos já existem, cria apenas os ausentes', async () => {
    const { service, kickApiService } = createService({
      kickApiService: {
        listEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          subscriptions: [
            {
              name: 'channel.subscription.gifts',
              version: 1,
              broadcasterUserId: '75942843',
            },
          ],
          diagnostics: [],
        }),
        createEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          results: [
            {
              name: 'channel.subscription.new',
              version: 1,
              subscriptionId: 'sub-new',
              error: null,
              confirmed: true,
            },
            {
              name: 'channel.subscription.renewal',
              version: 1,
              subscriptionId: 'sub-renewal',
              error: null,
              confirmed: true,
            },
            {
              name: 'channel.followed',
              version: 1,
              subscriptionId: 'sub-followed',
              error: null,
              confirmed: true,
            },
          ],
          diagnostics: [],
        }),
      },
    });

    const result = await service.syncDesiredEvents();

    const createPayload = kickApiService.createEventSubscriptions.mock.calls[0][0];
    expect(createPayload.events).toEqual([
      { name: 'channel.subscription.new', version: 1 },
      { name: 'channel.subscription.renewal', version: 1 },
      { name: 'channel.followed', version: 1 },
    ]);

    expect(result.alreadyActive).toEqual(['channel.subscription.gifts v1']);
    expect(result.created).toEqual([
      'channel.subscription.new v1',
      'channel.subscription.renewal v1',
      'channel.followed v1',
    ]);
    expect(result.failed).toEqual([]);
  });

  test('quando todos já existem, não executa POST desnecessário', async () => {
    const { service, kickApiService } = createService({
      kickApiService: {
        listEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          subscriptions: DESIRED_KICK_EVENTS.map((event) => ({
            ...event,
            broadcasterUserId: '75942843',
          })),
          diagnostics: [],
        }),
        createEventSubscriptions: jest.fn(),
      },
    });

    const result = await service.syncDesiredEvents();

    expect(kickApiService.createEventSubscriptions).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.alreadyActive).toHaveLength(DESIRED_KICK_EVENTS.length);
  });

  test('POST com resposta inesperada sem item correspondente vira falha com message da Kick', async () => {
    const { service } = createService({
      kickApiService: {
        listEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          subscriptions: [],
          diagnostics: [],
        }),
        createEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          results: [],
          diagnostics: [],
        }),
      },
    });

    const result = await service.syncDesiredEvents();

    expect(result.created).toEqual([]);
    expect(result.failed).toEqual([
      { event: 'channel.subscription.new v1', reason: 'OK' },
      { event: 'channel.subscription.renewal v1', reason: 'OK' },
      { event: 'channel.subscription.gifts v1', reason: 'OK' },
      { event: 'channel.followed v1', reason: 'OK' },
    ]);
  });

  test('POST com error individual preserva erro real no resumo', async () => {
    const { service } = createService({
      kickApiService: {
        listEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          subscriptions: [],
          diagnostics: [],
        }),
        createEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          results: [
            {
              name: 'channel.subscription.new',
              version: 1,
              subscriptionId: null,
              error: 'SUBSCRIPTION_LIMIT_REACHED',
              confirmed: false,
            },
            {
              name: 'channel.subscription.renewal',
              version: 1,
              subscriptionId: 'sub-renewal',
              error: null,
              confirmed: true,
            },
          ],
          diagnostics: [],
        }),
      },
    });

    const result = await service.syncDesiredEvents();

    expect(result.created).toEqual(['channel.subscription.renewal v1']);
    expect(result.failed).toEqual([
      { event: 'channel.subscription.new v1', reason: 'SUBSCRIPTION_LIMIT_REACHED' },
      { event: 'channel.subscription.gifts v1', reason: 'OK' },
      { event: 'channel.followed v1', reason: 'OK' },
    ]);
  });

  test('POST com error vazio e subscription_id presente confirma criação', async () => {
    const { service } = createService({
      kickApiService: {
        listEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          subscriptions: [],
          diagnostics: [],
        }),
        createEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          results: DESIRED_KICK_EVENTS.map((event) => ({
            name: event.name,
            version: event.version,
            subscriptionId: `sub-${event.name}`,
            error: null,
            confirmed: true,
          })),
          diagnostics: [],
        }),
      },
    });

    const result = await service.syncDesiredEvents();
    expect(result.created).toHaveLength(DESIRED_KICK_EVENTS.length);
    expect(result.failed).toEqual([]);
  });

  test('quando os três eventos de subscription já existem, cria apenas channel.followed', async () => {
    const { service, kickApiService } = createService({
      kickApiService: {
        listEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          subscriptions: [
            { name: 'channel.subscription.new', version: 1, broadcasterUserId: '75942843' },
            { name: 'channel.subscription.renewal', version: 1, broadcasterUserId: '75942843' },
            { name: 'channel.subscription.gifts', version: 1, broadcasterUserId: '75942843' },
          ],
          diagnostics: [],
        }),
        createEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          results: [
            {
              name: 'channel.followed',
              version: 1,
              subscriptionId: 'sub-followed-only',
              error: null,
              confirmed: true,
            },
          ],
          diagnostics: [],
        }),
      },
    });

    const result = await service.syncDesiredEvents();

    expect(kickApiService.createEventSubscriptions).toHaveBeenCalledTimes(1);
    expect(kickApiService.createEventSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [{ name: 'channel.followed', version: 1 }],
      }),
    );
    expect(result.created).toEqual(['channel.followed v1']);
    expect(result.alreadyActive).toEqual([
      'channel.subscription.new v1',
      'channel.subscription.renewal v1',
      'channel.subscription.gifts v1',
    ]);
    expect(result.failed).toEqual([]);
  });

  test('execução repetida é idempotente (segunda execução não cria)', async () => {
    const active = new Set();

    const kickApiService = {
      listEventSubscriptions: jest.fn().mockImplementation(async () => ({
        status: 200,
        message: 'OK',
        subscriptions: Array.from(active).map((key) => {
          const [name, version] = key.split('::');
          return {
            name,
            version: Number(version),
            broadcasterUserId: '75942843',
          };
        }),
        diagnostics: [],
      })),
      createEventSubscriptions: jest.fn().mockImplementation(async ({ events }) => {
        for (const event of events) {
          active.add(`${event.name}::${event.version}`);
        }

        return {
          status: 200,
          message: 'OK',
          results: events.map((event) => ({
            name: event.name,
            version: event.version,
            subscriptionId: `sub-${event.name}`,
            error: null,
            confirmed: true,
          })),
          diagnostics: [],
        };
      }),
    };

    const { service } = createService({ kickApiService });

    const first = await service.syncDesiredEvents();
    const second = await service.syncDesiredEvents();

    expect(first.created).toHaveLength(DESIRED_KICK_EVENTS.length);
    expect(second.created).toHaveLength(0);
    expect(second.alreadyActive).toHaveLength(DESIRED_KICK_EVENTS.length);
    expect(kickApiService.createEventSubscriptions).toHaveBeenCalledTimes(1);
  });

  test('erro 401 invalida token em memória e refaz tentativa', async () => {
    const kickApiService = {
      listEventSubscriptions: jest
        .fn()
        .mockRejectedValueOnce({ code: 'UNAUTHORIZED', httpStatus: 401 })
        .mockResolvedValueOnce({
          status: 200,
          message: 'OK',
          subscriptions: DESIRED_KICK_EVENTS.map((event) => ({
            ...event,
            broadcasterUserId: '75942843',
          })),
          diagnostics: [],
        }),
      createEventSubscriptions: jest.fn(),
    };

    const kickAppTokenService = {
      getAccessToken: jest
        .fn()
        .mockResolvedValueOnce('expired-token')
        .mockResolvedValueOnce('fresh-token'),
      invalidateToken: jest.fn(),
    };

    const { service } = createService({
      kickApiService,
      kickAppTokenService,
    });

    const result = await service.syncDesiredEvents();

    expect(kickAppTokenService.invalidateToken).toHaveBeenCalledTimes(1);
    expect(kickApiService.listEventSubscriptions).toHaveBeenCalledTimes(2);
    expect(result.alreadyActive).toHaveLength(DESIRED_KICK_EVENTS.length);
  });

  test.each([
    ['BAD_REQUEST', 400],
    ['FORBIDDEN', 403],
    ['RATE_LIMITED', 429],
    ['UPSTREAM_UNAVAILABLE', 502],
    ['REQUEST_TIMEOUT', 504],
  ])('propaga falha controlada na consulta: %s', async (code, httpStatus) => {
    const { service, kickAppTokenService } = createService({
      kickApiService: {
        listEventSubscriptions: jest.fn().mockRejectedValue({ code, httpStatus }),
        createEventSubscriptions: jest.fn(),
      },
    });

    await expect(service.syncDesiredEvents()).rejects.toMatchObject({ code, httpStatus });
    expect(kickAppTokenService.invalidateToken).not.toHaveBeenCalled();
  });

  test('falha na criação parcial retorna failed com motivo', async () => {
    const { service } = createService({
      kickApiService: {
        listEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          subscriptions: [
            {
              name: 'channel.subscription.gifts',
              version: 1,
              broadcasterUserId: '75942843',
            },
          ],
          diagnostics: [],
        }),
        createEventSubscriptions: jest.fn().mockRejectedValue({ code: 'RATE_LIMITED', httpStatus: 429 }),
      },
    });

    const result = await service.syncDesiredEvents();

    expect(result.alreadyActive).toEqual(['channel.subscription.gifts v1']);
    expect(result.created).toEqual([]);
    expect(result.failed).toEqual([
      { event: 'channel.subscription.new v1', reason: 'RATE_LIMITED' },
      { event: 'channel.subscription.renewal v1', reason: 'RATE_LIMITED' },
      { event: 'channel.followed v1', reason: 'RATE_LIMITED' },
    ]);
  });

  test('broadcaster ID inválido é rejeitado antes da requisição', async () => {
    const { service, kickApiService } = createService({
      config: {
        kickBroadcasterUserId: 'invalid-value',
      },
    });

    await expect(service.syncDesiredEvents()).rejects.toMatchObject({
      code: 'INVALID_BROADCASTER_ID',
      httpStatus: 400,
    });

    expect(kickApiService.listEventSubscriptions).not.toHaveBeenCalled();
  });

  test('diagnóstico seguro não registra credenciais', async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
    };

    const { service } = createService({
      logger,
      kickApiService: {
        listEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          subscriptions: [],
          diagnostics: [
            {
              name: 'channel.subscription.new',
              version: 1,
              subscriptionIdPresent: false,
              error: null,
            },
          ],
        }),
        createEventSubscriptions: jest.fn().mockResolvedValue({
          status: 200,
          message: 'OK',
          results: [],
          diagnostics: [
            {
              name: 'channel.subscription.new',
              version: 1,
              subscriptionIdPresent: false,
              error: 'LIMIT',
            },
          ],
        }),
      },
      kickAppTokenService: {
        getAccessToken: jest.fn().mockResolvedValue('super-secret-token'),
        invalidateToken: jest.fn(),
      },
    });

    await service.syncDesiredEvents();

    const combinedLogs = logger.info.mock.calls.map((call) => String(call[0])).join('\n');
    expect(combinedLogs).toContain('status=200');
    expect(combinedLogs).toContain('message=OK');
    expect(combinedLogs).not.toContain('super-secret-token');
    expect(combinedLogs).not.toContain('client-secret');
  });
});
