const config = require('../config');
const lifecycleService = require('./applicationLifecycleService');
const schedulerService = require('./schedulerService');
const subscriberRoleReconciliationScheduler = require('./subscriberRoleReconciliationScheduler');
const kickHttpServer = require('./kickHttpServer');
const sqliteClient = require('../database/sqliteClient');

function createErrorCode(error) {
  if (error && typeof error === 'object') {
    if (typeof error.code === 'string' && error.code.trim()) {
      return error.code.trim();
    }

    if (typeof error.name === 'string' && error.name.trim()) {
      return error.name.trim();
    }
  }

  return 'unknown_error';
}

function createGracefulShutdownService(options = {}) {
  const cfg = options.config || config;
  const logger = options.logger || console;
  const lifecycle = options.lifecycleService || lifecycleService;
  const queueScheduler = options.schedulerService || schedulerService;
  const reconciliationScheduler =
    options.subscriberRoleReconciliationScheduler || subscriberRoleReconciliationScheduler;
  const kickServer = options.kickHttpServer || kickHttpServer;
  const sqlite = options.sqliteClient || sqliteClient;
  const processRef = options.processRef || process;
  const shutdownTimeoutMs = Math.max(1, Number(options.shutdownTimeoutMs || cfg.shutdownTimeoutMs || 10_000));

  let shutdownPromise = null;
  let completedSummary = null;
  let handlersInstalled = false;
  let signalCount = 0;

  function createTimeoutTimer(onTimeout) {
    const timer = setTimeout(onTimeout, shutdownTimeoutMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    return timer;
  }

  async function runStage(summary, stageName, stageFn) {
    summary.stageOrder.push(stageName);
    summary.stages[stageName] = { status: 'started' };

    if (typeof logger?.info === 'function') {
      logger.info(`Shutdown: etapa iniciada ${stageName}`);
    }

    try {
      await stageFn();
      summary.stages[stageName] = { status: 'ok' };
      if (typeof logger?.info === 'function') {
        logger.info(`Shutdown: etapa concluida ${stageName}`);
      }
    } catch (error) {
      const safeCode = createErrorCode(error);
      summary.stages[stageName] = { status: 'failed', code: safeCode };
      summary.failures.push({ stage: stageName, code: safeCode });
      if (typeof logger?.warn === 'function') {
        logger.warn(`Shutdown: etapa falhou ${stageName} code=${safeCode}`);
      }
    }
  }

  function shutdown(input = {}) {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    if (completedSummary) {
      return Promise.resolve(completedSummary);
    }

    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'shutdown';
    const fatal = Boolean(input.fatal);

    const lifecycleResult = lifecycle.beginShutdown(reason);

    const summary = {
      reason,
      fatal,
      timedOut: false,
      timeoutMs: shutdownTimeoutMs,
      stageOrder: [],
      stages: {},
      failures: [],
      pendingStages: [],
      exitCode: fatal ? 1 : 0,
      lifecycleStartedNow: lifecycleResult.startedNow,
    };

    shutdownPromise = (async () => {
      const stageNames = [
        'stop_queue_scheduler',
        'stop_sub_reconciliation_scheduler',
        'stop_kick_http_server',
        'destroy_discord_client',
        'close_sqlite_connection',
      ];

      let timeoutResolve;
      const timeoutSignal = new Promise((resolve) => {
        timeoutResolve = resolve;
      });

      const timeoutTimer = createTimeoutTimer(() => {
        timeoutResolve('timeout');
      });

      const shutdownTask = (async () => {
        await runStage(summary, 'stop_queue_scheduler', async () => {
          if (typeof queueScheduler.stopScheduler === 'function') {
            queueScheduler.stopScheduler();
            return;
          }
          if (typeof queueScheduler.clearScheduledTimers === 'function') {
            queueScheduler.clearScheduledTimers();
          }
        });

        await runStage(summary, 'stop_sub_reconciliation_scheduler', async () => {
          if (typeof reconciliationScheduler.stop === 'function') {
            reconciliationScheduler.stop();
          }
        });

        await runStage(summary, 'stop_kick_http_server', async () => {
          if (typeof kickServer.stopKickHttpServer === 'function') {
            await kickServer.stopKickHttpServer();
          }
        });

        await runStage(summary, 'destroy_discord_client', async () => {
          const client = input.discordClient;
          if (client && typeof client.destroy === 'function') {
            await Promise.resolve(client.destroy());
          }
        });

        await runStage(summary, 'close_sqlite_connection', async () => {
          if (typeof sqlite.closeConnection === 'function') {
            await sqlite.closeConnection();
          }
        });

        return 'done';
      })();

      const outcome = await Promise.race([shutdownTask, timeoutSignal]);
      clearTimeout(timeoutTimer);

      if (outcome === 'timeout') {
        summary.timedOut = true;
        summary.exitCode = 1;
        summary.pendingStages = stageNames.filter((stageName) => {
          const status = summary.stages[stageName]?.status;
          return status !== 'ok' && status !== 'failed';
        });
        if (typeof logger?.warn === 'function') {
          logger.warn(
            `Shutdown: tempo limite excedido (${shutdownTimeoutMs}ms); etapas pendentes: ${summary.pendingStages.join(', ') || 'none'}`,
          );
        }
      }

      if (!summary.timedOut && summary.failures.length > 0) {
        summary.exitCode = 1;
      }

      if (fatal) {
        summary.exitCode = 1;
      }

      processRef.exitCode = summary.exitCode;
      completedSummary = summary;
      shutdownPromise = null;
      return summary;
    })();

    return shutdownPromise;
  }

  function installProcessHandlers(input = {}) {
    if (handlersInstalled) {
      return { installed: false, reason: 'already_installed' };
    }

    const forceExitOnSecondSignal = input.forceExitOnSecondSignal !== false;

    const onSignal = (signalName) => {
      signalCount += 1;

      if (lifecycle.isShuttingDown()) {
        if (typeof logger?.warn === 'function') {
          logger.warn(`Shutdown: sinal adicional recebido (${signalName}).`);
        }
        if (signalCount >= 2 && forceExitOnSecondSignal && typeof processRef.exit === 'function') {
          processRef.exit(1);
        }
        return;
      }

      shutdown({
        reason: signalName,
        fatal: false,
        discordClient: input.discordClient,
      }).catch(() => {
        processRef.exitCode = 1;
      });
    };

    const onUnhandledRejection = () => {
      if (typeof logger?.error === 'function') {
        logger.error('Erro não tratado: unhandledRejection.');
      }

      shutdown({
        reason: 'unhandledRejection',
        fatal: true,
        discordClient: input.discordClient,
      }).catch(() => {
        processRef.exitCode = 1;
      });
    };

    const onUncaughtException = () => {
      if (typeof logger?.error === 'function') {
        logger.error('Erro não capturado: uncaughtException.');
      }

      shutdown({
        reason: 'uncaughtException',
        fatal: true,
        discordClient: input.discordClient,
      }).catch(() => {
        processRef.exitCode = 1;
      });
    };

    processRef.on('SIGINT', () => onSignal('SIGINT'));
    processRef.on('SIGTERM', () => onSignal('SIGTERM'));
    processRef.on('unhandledRejection', onUnhandledRejection);
    processRef.on('uncaughtException', onUncaughtException);

    handlersInstalled = true;
    return { installed: true };
  }

  function getState() {
    return {
      handlersInstalled,
      signalCount,
      hasCompletedSummary: Boolean(completedSummary),
      shutdownInProgress: Boolean(shutdownPromise),
    };
  }

  function _resetForTests() {
    shutdownPromise = null;
    completedSummary = null;
    handlersInstalled = false;
    signalCount = 0;
  }

  return {
    shutdown,
    installProcessHandlers,
    getState,
    _resetForTests,
  };
}

const defaultService = createGracefulShutdownService();
defaultService.createGracefulShutdownService = createGracefulShutdownService;

module.exports = defaultService;
