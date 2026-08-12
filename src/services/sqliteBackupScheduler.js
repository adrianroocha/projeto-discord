const config = require('../config');
const lifecycleService = require('./applicationLifecycleService');
const sqliteBackupService = require('./sqliteBackupService');
const schedulerTimeService = require('./schedulerTimeService');
const sqliteBackupSchedulerStateRepository = require('../database/sqliteBackupSchedulerStateRepository');

const RETRY_DELAY_MS = 30 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function createFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

function formatParts(formatter, valueMs) {
  const parts = formatter.formatToParts(new Date(valueMs));
  const bag = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      bag[part.type] = part.value;
    }
  }

  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function localDateKey(parts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function toUtcFromLocal(localShape, formatter) {
  let guess = Date.UTC(
    localShape.year,
    localShape.month - 1,
    localShape.day,
    localShape.hour,
    localShape.minute,
    localShape.second || 0,
  );

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = formatParts(formatter, guess);
    const desired = Date.UTC(
      localShape.year,
      localShape.month - 1,
      localShape.day,
      localShape.hour,
      localShape.minute,
      localShape.second || 0,
    );
    const currentShape = Date.UTC(
      current.year,
      current.month - 1,
      current.day,
      current.hour,
      current.minute,
      current.second,
    );
    const diff = desired - currentShape;
    if (diff === 0) {
      return guess;
    }
    guess += diff;
  }

  return guess;
}

function addDays(localKey, deltaDays) {
  return schedulerTimeService.addDaysToLocalDateKey(localKey, deltaDays);
}

function parseLocalKey(localKey) {
  const match = String(localKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Data local inválida: ${localKey}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function computeTargetAtMs(localDate, backupTime, formatter) {
  const parsedDate = parseLocalKey(localDate);
  return toUtcFromLocal(
    {
      year: parsedDate.year,
      month: parsedDate.month,
      day: parsedDate.day,
      hour: backupTime.hour,
      minute: backupTime.minute,
      second: 0,
    },
    formatter,
  );
}

function createSqliteBackupScheduler(options = {}) {
  const cfg = options.config || config;
  const logger = options.logger || console;
  const lifecycle = options.lifecycleService || lifecycleService;
  const backupService = options.sqliteBackupService || sqliteBackupService;
  const stateRepository =
    options.sqliteBackupSchedulerStateRepository || sqliteBackupSchedulerStateRepository;
  const now = options.now || nowMs;

  let started = false;
  let stopped = false;
  let timer = null;
  let backupPromise = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function parseScheduleConfig() {
    schedulerTimeService.assertValidTimeZone(cfg.sqliteBackupTimezone);
    const backupTime = schedulerTimeService.parseTimeLabel(cfg.sqliteBackupTime, 'SQLITE_BACKUP_TIME');
    const formatter = createFormatter(cfg.sqliteBackupTimezone);
    return {
      backupTime,
      formatter,
    };
  }

  function computeLocalDateFromMs(valueMs) {
    const { formatter } = parseScheduleConfig();
    return localDateKey(formatParts(formatter, valueMs));
  }

  function computeSchedule(referenceNowMs = now()) {
    const safeNowMs = Number(referenceNowMs);
    const parsedNowMs = Number.isFinite(safeNowMs) ? Math.trunc(safeNowMs) : now();
    const { backupTime, formatter } = parseScheduleConfig();
    const nowParts = formatParts(formatter, parsedNowMs);
    const todayKey = localDateKey(nowParts);
    const nowMinutes = nowParts.hour * 60 + nowParts.minute;
    const targetMinutes = backupTime.hour * 60 + backupTime.minute;

    const todayTargetAtMs = computeTargetAtMs(todayKey, backupTime, formatter);
    const nextDateKey = nowMinutes < targetMinutes ? todayKey : addDays(todayKey, 1);
    const nextRunAtMs = computeTargetAtMs(nextDateKey, backupTime, formatter);

    return {
      todayKey,
      nowMinutes,
      targetMinutes,
      todayTargetAtMs,
      nextDateKey,
      nextRunAtMs,
    };
  }

  async function executeBackup(triggerType) {
    if (backupPromise) {
      return backupPromise;
    }

    const startedAtMs = now();
    const todayLocalDate = computeLocalDateFromMs(startedAtMs);
    stateRepository.updateState({
      lastAttemptStartedAtMs: startedAtMs,
      lastResult: 'running',
    });

    backupPromise = (async () => {
      const backupResult = await backupService.createBackup({ triggerType });

      if (backupResult.success) {
        stateRepository.updateState({
          lastSuccessLocalDate: todayLocalDate,
          lastAttemptStartedAtMs: startedAtMs,
          lastResult: 'ok',
        });

        try {
          const retention = backupService.cleanupRetention(cfg.sqliteBackupRetentionDays);
          if (typeof logger?.info === 'function') {
            logger.info(
              `SQLite backup retention cleaned removed=${retention.removedCount} scanned=${retention.scannedCount}`,
            );
          }
        } catch (retentionError) {
          if (typeof logger?.warn === 'function') {
            logger.warn(`SQLite backup retention warning code=${retentionError.code || 'RETENTION_FAILED'}`);
          }
        }
      } else {
        stateRepository.updateState({
          lastAttemptStartedAtMs: startedAtMs,
          lastResult: 'failed',
        });
      }

      return backupResult;
    })();

    try {
      return await backupPromise;
    } finally {
      backupPromise = null;
    }
  }

  function scheduleOnce(targetAtMs, reason) {
    clearTimer();

    if (stopped || lifecycle.isShuttingDown()) {
      return;
    }

    const delayMs = Math.max(1, Math.trunc(targetAtMs - now()));
    timer = setTimeout(() => {
      runCycle(reason).catch((error) => {
        if (typeof logger?.error === 'function') {
          logger.error(`SQLite backup scheduler cycle error code=${error.code || 'CYCLE_FAILED'}`);
        }
      });
    }, delayMs);

    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  async function runCycle(_reason) {
    if (stopped || lifecycle.isShuttingDown()) {
      return;
    }

    const result = await executeBackup('scheduled');

    if (!result.success) {
      scheduleOnce(now() + RETRY_DELAY_MS, 'retry_after_failure');
      return;
    }

    const schedule = computeSchedule(now());
    scheduleOnce(schedule.nextRunAtMs, 'next_daily');
  }

  function shouldRunMissedOnce(schedule, state) {
    if (schedule.nowMinutes < schedule.targetMinutes) {
      return false;
    }

    if (state && state.last_success_local_date === schedule.todayKey) {
      return false;
    }

    if (state && Number.isFinite(Number(state.last_attempt_started_at_ms))) {
      const lastAttemptLocalDate = computeLocalDateFromMs(Number(state.last_attempt_started_at_ms));
      if (lastAttemptLocalDate === schedule.todayKey) {
        return false;
      }
    }

    return true;
  }

  function start() {
    if (started) {
      return { started: false, reason: 'already_started' };
    }

    if (!cfg.sqliteBackupEnabled) {
      return { started: false, reason: 'disabled' };
    }

    if (cfg.nodeEnv === 'test') {
      return { started: false, reason: 'test_environment' };
    }

    started = true;
    stopped = false;

    const schedule = computeSchedule(now());
    const state = stateRepository.getState();

    if (shouldRunMissedOnce(schedule, state)) {
      const startupDelayMs = Math.max(
        0,
        Math.trunc(Number(cfg.sqliteBackupStartupDelaySeconds || 60) * 1000),
      );
      scheduleOnce(now() + startupDelayMs, 'missed_run_after_startup');
      return { started: true, reason: 'scheduled_missed_run', nextAtMs: now() + startupDelayMs };
    }

    scheduleOnce(schedule.nextRunAtMs, 'next_daily');
    return { started: true, reason: 'scheduled_next_daily', nextAtMs: schedule.nextRunAtMs };
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
    if (!backupPromise) {
      return { waited: false, timeout: false };
    }

    return backupService.waitForOngoingBackup({ timeoutMs });
  }

  function getStatus() {
    const schedule = computeSchedule(now());
    return {
      started,
      stopped,
      timerActive: Boolean(timer),
      runningBackup: Boolean(backupPromise),
      todayKey: schedule.todayKey,
      nextRunAtMs: schedule.nextRunAtMs,
      timezone: cfg.sqliteBackupTimezone,
      backupTime: cfg.sqliteBackupTime,
      enabled: cfg.sqliteBackupEnabled,
    };
  }

  return {
    start,
    stop,
    waitForIdle,
    getStatus,
    computeSchedule,
    computeLocalDateFromMs,
    _resetForTests: () => {
      clearTimer();
      started = false;
      stopped = false;
      backupPromise = null;
    },
  };
}

const defaultScheduler = createSqliteBackupScheduler();
defaultScheduler.createSqliteBackupScheduler = createSqliteBackupScheduler;

module.exports = defaultScheduler;
