const config = require('../config');
const lifecycleService = require('./applicationLifecycleService');
const adminCommandAuditLogsRepository = require('../database/adminCommandAuditLogsRepository');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_CODE = 'ADMIN_AUDIT_RETENTION_FAILED';

function nowMs() {
  return Date.now();
}

function createAdminAuditRetentionScheduler(options = {}) {
  const cfg = options.config || config;
  const lifecycle = options.lifecycleService || lifecycleService;
  const repository = options.adminCommandAuditLogsRepository || adminCommandAuditLogsRepository;
  const logger = options.logger || console;
  const now = options.now || nowMs;

  let started = false;
  let stopped = false;
  let timer = null;
  let cleanupPromise = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function computeCutoffMs(referenceMs = now()) {
    const retentionDays = Number(cfg.adminAuditRetentionDays);
    return Math.trunc(referenceMs - retentionDays * ONE_DAY_MS);
  }

  async function runCleanupOnce() {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    cleanupPromise = (async () => {
      const cutoffMs = computeCutoffMs(now());
      try {
        const removed = repository.deleteOlderThan(cutoffMs);
        if (typeof logger?.info === 'function') {
          logger.info(`Admin audit retention cleaned removed=${removed}`);
        }
        return { ok: true, removed };
      } catch {
        if (typeof logger?.warn === 'function') {
          logger.warn(`Admin audit retention failed code=${FAILURE_CODE}`);
        }
        return { ok: false, removed: 0, code: FAILURE_CODE };
      }
    })();

    try {
      return await cleanupPromise;
    } finally {
      cleanupPromise = null;
    }
  }

  function scheduleNextRun(delayMs = ONE_DAY_MS) {
    clearTimer();

    if (stopped || lifecycle.isShuttingDown()) {
      return;
    }

    const safeDelayMs = Math.max(1, Math.trunc(Number(delayMs) || ONE_DAY_MS));
    timer = setTimeout(() => {
      void runCycle();
    }, safeDelayMs);

    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  async function runCycle() {
    if (stopped || lifecycle.isShuttingDown()) {
      return;
    }

    await runCleanupOnce();

    if (!stopped && !lifecycle.isShuttingDown()) {
      scheduleNextRun(ONE_DAY_MS);
    }
  }

  async function start() {
    if (started) {
      return { started: false, reason: 'already_started' };
    }

    started = true;
    stopped = false;

    await runCleanupOnce();

    if (cfg.nodeEnv === 'test') {
      return { started: true, reason: 'test_environment_no_timer' };
    }

    if (!lifecycle.isShuttingDown()) {
      scheduleNextRun(ONE_DAY_MS);
    }

    return { started: true, reason: 'scheduled_next_daily', nextInMs: ONE_DAY_MS };
  }

  function stop() {
    if (stopped) {
      return { stopped: false, reason: 'already_stopped' };
    }

    stopped = true;
    clearTimer();
    return { stopped: true };
  }

  async function waitForIdle(timeoutMs) {
    if (!cleanupPromise) {
      return { waited: false, timeout: false };
    }

    let timerRef = null;
    const timeoutPromise = new Promise((resolve) => {
      const limitMs = Math.max(1, Math.trunc(Number(timeoutMs) || 1000));
      timerRef = setTimeout(() => resolve({ waited: true, timeout: true }), limitMs);
      if (timerRef && typeof timerRef.unref === 'function') {
        timerRef.unref();
      }
    });

    const completionPromise = cleanupPromise.then(() => ({ waited: true, timeout: false }));
    const result = await Promise.race([completionPromise, timeoutPromise]);
    if (timerRef) {
      clearTimeout(timerRef);
    }

    return result;
  }

  function getStatus() {
    return {
      started,
      stopped,
      timerActive: Boolean(timer),
      runningCleanup: Boolean(cleanupPromise),
      retentionDays: Number(cfg.adminAuditRetentionDays),
    };
  }

  function _resetForTests() {
    clearTimer();
    started = false;
    stopped = false;
    cleanupPromise = null;
  }

  return {
    start,
    stop,
    waitForIdle,
    getStatus,
    computeCutoffMs,
    runCleanupOnce,
    _resetForTests,
  };
}

const defaultService = createAdminAuditRetentionScheduler();
defaultService.createAdminAuditRetentionScheduler = createAdminAuditRetentionScheduler;

module.exports = defaultService;
