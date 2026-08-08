const { EventEmitter } = require('events');
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'guild-1';

const { createGracefulShutdownService } = require('../src/services/gracefulShutdownService');
const { createApplicationLifecycleService } = require('../src/services/applicationLifecycleService');

function createProcessStub() {
  const emitter = new EventEmitter();
  emitter.exitCode = undefined;
  emitter.exit = jest.fn();
  return emitter;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('gracefulShutdownService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createService(overrides = {}) {
    const lifecycle = overrides.lifecycleService || createApplicationLifecycleService();
    const processRef = overrides.processRef || createProcessStub();

    const schedulerService = overrides.schedulerService || {
      stopScheduler: jest.fn(),
    };

    const subscriberRoleReconciliationScheduler =
      overrides.subscriberRoleReconciliationScheduler || {
        stop: jest.fn(),
      };

    const kickHttpServer = overrides.kickHttpServer || {
      stopKickHttpServer: jest.fn().mockResolvedValue(undefined),
    };

    const sqliteClient = overrides.sqliteClient || {
      closeConnection: jest.fn().mockResolvedValue(undefined),
    };

    const logger =
      overrides.logger || {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };

    const service = createGracefulShutdownService({
      config: { shutdownTimeoutMs: overrides.shutdownTimeoutMs || 1000 },
      lifecycleService: lifecycle,
      schedulerService,
      subscriberRoleReconciliationScheduler,
      kickHttpServer,
      sqliteClient,
      processRef,
      logger,
      shutdownTimeoutMs: overrides.shutdownTimeoutMs || 1000,
    });

    return {
      service,
      lifecycle,
      processRef,
      schedulerService,
      subscriberRoleReconciliationScheduler,
      kickHttpServer,
      sqliteClient,
      logger,
    };
  }

  test('ordem correta das etapas e sqlite por último', async () => {
    const discordClient = { destroy: jest.fn().mockResolvedValue(undefined) };
    const { service } = createService();

    const summary = await service.shutdown({ reason: 'SIGINT', discordClient });

    expect(summary.stageOrder).toEqual([
      'stop_queue_scheduler',
      'stop_sub_reconciliation_scheduler',
      'stop_kick_http_server',
      'destroy_discord_client',
      'close_sqlite_connection',
    ]);
    expect(summary.stageOrder[summary.stageOrder.length - 1]).toBe('close_sqlite_connection');
  });

  test('SIGINT encerra com exitCode 0', async () => {
    const { service, processRef } = createService();

    service.installProcessHandlers({ discordClient: { destroy: jest.fn() }, forceExitOnSecondSignal: false });
    processRef.emit('SIGINT');
    await jest.advanceTimersByTimeAsync(0);

    expect(processRef.exitCode).toBe(0);
  });

  test('SIGTERM encerra com exitCode 0', async () => {
    const { service, processRef } = createService();

    service.installProcessHandlers({ discordClient: { destroy: jest.fn() }, forceExitOnSecondSignal: false });
    processRef.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(0);

    expect(processRef.exitCode).toBe(0);
  });

  test('uncaughtException encerra com exitCode 1', async () => {
    const { service, processRef } = createService();

    service.installProcessHandlers({ discordClient: { destroy: jest.fn() }, forceExitOnSecondSignal: false });
    processRef.emit('uncaughtException', new Error('fatal'));
    await jest.advanceTimersByTimeAsync(0);

    expect(processRef.exitCode).toBe(1);
  });

  test('unhandledRejection encerra com exitCode 1', async () => {
    const { service, processRef } = createService();

    service.installProcessHandlers({ discordClient: { destroy: jest.fn() }, forceExitOnSecondSignal: false });
    processRef.emit('unhandledRejection', new Error('fatal'));
    await jest.advanceTimersByTimeAsync(0);

    expect(processRef.exitCode).toBe(1);
  });

  test('duas chamadas simultâneas compartilham a mesma promise', async () => {
    const deferred = createDeferred();
    const { service } = createService({
      kickHttpServer: {
        stopKickHttpServer: jest.fn(() => deferred.promise),
      },
    });

    const p1 = service.shutdown({ reason: 'A' });
    const p2 = service.shutdown({ reason: 'B' });

    expect(p1).toBe(p2);

    deferred.resolve();
    await p1;
  });

  test('segunda chamada após conclusão é segura', async () => {
    const { service } = createService();

    const first = await service.shutdown({ reason: 'SIGINT' });
    const second = await service.shutdown({ reason: 'SIGINT' });

    expect(second).toEqual(first);
  });

  test('falha ao parar scheduler não impede demais etapas', async () => {
    const sqliteClient = { closeConnection: jest.fn().mockResolvedValue(undefined) };
    const discordClient = { destroy: jest.fn().mockResolvedValue(undefined) };

    const { service } = createService({
      schedulerService: {
        stopScheduler: jest.fn(() => {
          throw new Error('scheduler failed');
        }),
      },
      sqliteClient,
    });

    const summary = await service.shutdown({ reason: 'SIGINT', discordClient });

    expect(summary.failures.length).toBe(1);
    expect(discordClient.destroy).toHaveBeenCalled();
    expect(sqliteClient.closeConnection).toHaveBeenCalled();
  });

  test('falha no fechamento HTTP não impede Discord e SQLite', async () => {
    const sqliteClient = { closeConnection: jest.fn().mockResolvedValue(undefined) };
    const discordClient = { destroy: jest.fn().mockResolvedValue(undefined) };

    const { service } = createService({
      kickHttpServer: {
        stopKickHttpServer: jest.fn().mockRejectedValue(new Error('http close failed')),
      },
      sqliteClient,
    });

    const summary = await service.shutdown({ reason: 'SIGINT', discordClient });

    expect(summary.failures.length).toBe(1);
    expect(discordClient.destroy).toHaveBeenCalled();
    expect(sqliteClient.closeConnection).toHaveBeenCalled();
  });

  test('falha no destroy do Discord não impede SQLite', async () => {
    const sqliteClient = { closeConnection: jest.fn().mockResolvedValue(undefined) };
    const discordClient = {
      destroy: jest.fn().mockRejectedValue(new Error('discord destroy failed')),
    };

    const { service } = createService({ sqliteClient });

    const summary = await service.shutdown({ reason: 'SIGINT', discordClient });

    expect(summary.failures.length).toBe(1);
    expect(sqliteClient.closeConnection).toHaveBeenCalled();
  });

  test('banco já fechado não causa erro', async () => {
    const { service } = createService({
      sqliteClient: {
        closeConnection: jest.fn().mockResolvedValue(undefined),
      },
    });

    const summary = await service.shutdown({ reason: 'SIGINT' });
    expect(summary.timedOut).toBe(false);
  });

  test('HTTP não iniciado não causa erro', async () => {
    const { service } = createService({
      kickHttpServer: {
        stopKickHttpServer: jest.fn().mockResolvedValue(undefined),
      },
    });

    const summary = await service.shutdown({ reason: 'SIGINT' });
    expect(summary.timedOut).toBe(false);
  });

  test('schedulers não iniciados não causam erro', async () => {
    const { service } = createService({
      schedulerService: { stopScheduler: jest.fn() },
      subscriberRoleReconciliationScheduler: { stop: jest.fn() },
    });

    const summary = await service.shutdown({ reason: 'SIGINT' });
    expect(summary.timedOut).toBe(false);
  });

  test('timeout de segurança marca pendências', async () => {
    const deferred = createDeferred();
    const { service, processRef } = createService({
      shutdownTimeoutMs: 50,
      kickHttpServer: {
        stopKickHttpServer: jest.fn(() => deferred.promise),
      },
    });

    const promise = service.shutdown({ reason: 'SIGINT' });
    await jest.advanceTimersByTimeAsync(60);
    const summary = await promise;

    expect(summary.timedOut).toBe(true);
    expect(summary.pendingStages).toContain('stop_kick_http_server');
    expect(processRef.exitCode).toBe(1);

    deferred.resolve();
  });

  test('timeout é cancelado quando shutdown finaliza', async () => {
    const { service } = createService({ shutdownTimeoutMs: 5000 });

    const summary = await service.shutdown({ reason: 'SIGINT' });
    expect(summary.timedOut).toBe(false);
  });

  test('nenhum timer aberto permanece após shutdown', async () => {
    const { service } = createService({ shutdownTimeoutMs: 5000 });

    await service.shutdown({ reason: 'SIGINT' });

    expect(jest.getTimerCount()).toBe(0);
  });

  test('segundo sinal durante shutdown pode forçar saída', async () => {
    const deferred = createDeferred();
    const { service, processRef } = createService({
      kickHttpServer: {
        stopKickHttpServer: jest.fn(() => deferred.promise),
      },
    });

    service.installProcessHandlers({ discordClient: { destroy: jest.fn() } });
    processRef.emit('SIGTERM');
    processRef.emit('SIGTERM');

    expect(processRef.exit).toHaveBeenCalledWith(1);

    deferred.resolve();
  });

  test('listeners de processo não são duplicados', () => {
    const { service } = createService();

    const first = service.installProcessHandlers({ discordClient: { destroy: jest.fn() } });
    const second = service.installProcessHandlers({ discordClient: { destroy: jest.fn() } });

    expect(first.installed).toBe(true);
    expect(second).toEqual({ installed: false, reason: 'already_installed' });
  });
});
