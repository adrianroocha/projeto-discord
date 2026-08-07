const config = require('../config');
const reconciliationService = require('./subscriberRoleReconciliationService');

let startupTimer = null;
let loopTimer = null;
let started = false;

function clearTimers() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

function isTestEnv(cfg) {
  return cfg.nodeEnv === 'test';
}

function createSubscriberRoleReconciliationScheduler(options = {}) {
  const cfg = options.config || config;
  const logger = options.logger || console;
  const service = options.subscriberRoleReconciliationService || reconciliationService;

  function runOnce(client, reasonLabel) {
    return service
      .reconcileAll({
        client,
        triggeredByDiscordId: null,
        triggerType: 'scheduler_sub_reconcile',
        reason: reasonLabel,
      })
      .then((result) => {
        if (result.status === 'already_running') {
          if (typeof logger?.info === 'function') {
            logger.info('Reconciliação SUB agendada ignorada: execução já em andamento.');
          }
        }
      })
      .catch((_error) => {
        if (typeof logger?.warn === 'function') {
          logger.warn('Reconciliação SUB agendada falhou de forma segura.');
        }
      });
  }

  function scheduleNext(client, intervalMs, reasonLabel) {
    if (!started) {
      return;
    }

    loopTimer = setTimeout(async () => {
      await runOnce(client, reasonLabel);
      scheduleNext(client, intervalMs, reasonLabel);
    }, intervalMs);
  }

  function start(client) {
    if (started) {
      return { started: false, reason: 'already_started' };
    }

    if (isTestEnv(cfg)) {
      return { started: false, reason: 'disabled_test_env' };
    }

    if (!cfg.subRoleReconciliationEnabled) {
      return { started: false, reason: 'disabled_config' };
    }

    const intervalMinutes = Number(cfg.subRoleReconciliationIntervalMinutes || 15);
    const startupDelaySeconds = Number(cfg.subRoleReconciliationStartupDelaySeconds || 30);

    const safeIntervalMs = Math.max(1, Math.trunc(intervalMinutes)) * 60 * 1000;
    const safeStartupDelayMs = Math.max(0, Math.trunc(startupDelaySeconds)) * 1000;

    startupTimer = setTimeout(async () => {
      const reasonLabel = 'Reconciliação periódica automática de cargo SUB';
      await runOnce(client, reasonLabel);
      scheduleNext(client, safeIntervalMs, reasonLabel);
    }, safeStartupDelayMs);

    started = true;

    if (typeof logger?.info === 'function') {
      logger.info(
        `Scheduler de reconciliação SUB iniciado (delay=${safeStartupDelayMs}ms, intervalo=${safeIntervalMs}ms).`,
      );
    }

    return {
      started: true,
      reason: 'started',
      startupDelayMs: safeStartupDelayMs,
      intervalMs: safeIntervalMs,
    };
  }

  function stop() {
    clearTimers();
    started = false;
  }

  function getStatus() {
    return {
      enabled: Boolean(cfg.subRoleReconciliationEnabled),
      started,
      running: service.isRunning(),
      intervalMinutes: Number(cfg.subRoleReconciliationIntervalMinutes || 15),
      startupDelaySeconds: Number(cfg.subRoleReconciliationStartupDelaySeconds || 30),
    };
  }

  return {
    start,
    stop,
    getStatus,
    _private: {
      clearTimers,
    },
  };
}

const defaultScheduler = createSubscriberRoleReconciliationScheduler();
defaultScheduler.createSubscriberRoleReconciliationScheduler = createSubscriberRoleReconciliationScheduler;

module.exports = defaultScheduler;
