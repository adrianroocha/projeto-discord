const config = require('../config');
const queueService = require('./queueService');
const queueMessageService = require('./queueMessageService');
const lifecycleService = require('./applicationLifecycleService');
const schedulerStateRepository = require('../database/schedulerStateRepository');
const schedulerTimeService = require('./schedulerTimeService');
const { getDatabase } = require('../database/sqliteClient');

let schedulerState = 'closed';
let schedulerOrigin = 'scheduled';
let activeCycleKey = null;
let schedulerTimer = null;
let schedulerStarted = false;
let schedulerStopped = false;
let schedulerClient = null;

function isDevelopmentMode() {
  return config.nodeEnv === 'development';
}

function nowMs() {
  return Date.now();
}

async function updatePanel(client) {
  await queueMessageService.updatePanel(client, { isQueueOpen: schedulerState === 'open' });
}

function clearScheduledTimers() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

function formatDateMsInConfiguredTimezone(valueMs) {
  if (!Number.isFinite(Number(valueMs))) {
    return 'indisponível';
  }

  return schedulerTimeService.formatInTimeZone(Number(valueMs), config.queueTimezone);
}

function getScheduleSnapshot(referenceNowMs = nowMs()) {
  return schedulerTimeService.computeScheduleSnapshot({
    nowMs: referenceNowMs,
    openTime: config.queueOpenTime,
    closeTime: config.queueCloseTime,
    timeZone: config.queueTimezone,
  });
}

function setRuntimeState(targetState, origin, cycleKey) {
  schedulerState = targetState;
  schedulerOrigin = origin;
  activeCycleKey = cycleKey || null;
}

async function applyOpenState(client, options = {}) {
  const origin = options.origin || 'scheduled';
  const shouldReset = options.shouldReset === true;

  if (shouldReset) {
    queueService.resetQueueCycle();
  }

  setRuntimeState('open', origin, options.cycleKey || null);
  await updatePanel(client);
}

async function applyClosedState(client, options = {}) {
  const origin = options.origin || 'scheduled';
  setRuntimeState('closed', origin, null);
  await updatePanel(client);
}

function scheduleProductionTransition(targetAtMs) {
  clearScheduledTimers();

  if (schedulerStopped || lifecycleService.isShuttingDown() || !schedulerStarted) {
    return;
  }

  const delay = Math.max(1, Math.trunc(Number(targetAtMs) - nowMs()));
  schedulerTimer = setTimeout(() => {
    reconcileProductionState(schedulerClient, { reason: 'timer' }).catch((error) => {
      console.error('Scheduler: falha ao aplicar transição agendada:', error);
      const retryDelayMs = 30_000;
      if (!schedulerStopped && schedulerStarted && !lifecycleService.isShuttingDown()) {
        schedulerTimer = setTimeout(() => {
          reconcileProductionState(schedulerClient, { reason: 'retry_after_failure' }).catch((retryError) => {
            console.error('Scheduler: falha na tentativa de recuperação:', retryError);
          });
        }, retryDelayMs);
      }
    });
  }, delay);

  if (schedulerTimer && typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}

function hasActiveManualOverride(state, currentNowMs) {
  if (!state || !state.manualOverrideState) {
    return false;
  }

  if (!Number.isFinite(Number(state.manualOverrideUntilMs))) {
    return false;
  }

  return Number(state.manualOverrideUntilMs) > currentNowMs;
}

function clearManualOverride(state) {
  return schedulerStateRepository.updateState({
    currentState: state.currentState,
    stateOrigin: 'scheduled',
    manualOverrideState: null,
    manualOverrideUntilMs: null,
    updatedAtMs: nowMs(),
  });
}

function getCurrentQueueCycleId(db) {
  const row = db.prepare('SELECT current_cycle_id FROM queue_cycle_state WHERE id = 1').get();
  if (!row || !Number.isFinite(Number(row.current_cycle_id)) || Number(row.current_cycle_id) < 1) {
    throw new Error('Estado inválido de queue_cycle_state.current_cycle_id.');
  }

  return Math.trunc(Number(row.current_cycle_id));
}

function getMostRecentScheduledCloseCycleKey(snapshot) {
  if (!snapshot || !snapshot.localNowKey || !snapshot.localNowParts) {
    return null;
  }

  const openTime = schedulerTimeService.parseTimeLabel(snapshot.openTime, 'QUEUE_OPEN_TIME');
  const nowMinutes = snapshot.localNowParts.hour * 60 + snapshot.localNowParts.minute;

  if (snapshot.crossesMidnight) {
    return schedulerTimeService.addDaysToLocalDateKey(snapshot.localNowKey, -1);
  }

  if (nowMinutes < openTime.totalMinutes) {
    return schedulerTimeService.addDaysToLocalDateKey(snapshot.localNowKey, -1);
  }

  return snapshot.localNowKey;
}

function persistScheduledClosedState(currentNowMs) {
  schedulerStateRepository.updateState({
    currentState: 'closed',
    stateOrigin: 'scheduled',
    manualOverrideState: null,
    manualOverrideUntilMs: null,
    updatedAtMs: currentNowMs,
  });
}

function finalizeCycleForScheduledClose(cycleKey, currentNowMs) {
  if (!cycleKey) {
    return { alreadyFinalized: true, cycleIdBefore: null, cycleIdAfter: null };
  }

  const db = getDatabase();
  const deleteLobbyPlayers = db.prepare('DELETE FROM lobby_players');
  const deleteLobbies = db.prepare('DELETE FROM lobbies');
  const deleteQueueEntries = db.prepare('DELETE FROM queue_entries');
  const deleteQueuePrioritySnapshotsByCycle = db.prepare('DELETE FROM queue_priority_snapshots WHERE cycle_id = ?');
  const incrementCycleId = db.prepare(
    'UPDATE queue_cycle_state SET current_cycle_id = current_cycle_id + 1, updated_at_ms = ? WHERE id = 1',
  );

  const transaction = db.transaction(() => {
    const persistedState = schedulerStateRepository.getState(db);
    if (persistedState.lastScheduledCloseCycleKey === cycleKey) {
      return {
        alreadyFinalized: true,
        cycleIdBefore: getCurrentQueueCycleId(db),
        cycleIdAfter: getCurrentQueueCycleId(db),
      };
    }

    const cycleIdBefore = getCurrentQueueCycleId(db);

    deleteLobbyPlayers.run();
    deleteLobbies.run();
    deleteQueueEntries.run();
    deleteQueuePrioritySnapshotsByCycle.run(cycleIdBefore);
    incrementCycleId.run(currentNowMs);

    schedulerStateRepository.updateState(
      {
        currentState: 'closed',
        stateOrigin: 'scheduled',
        manualOverrideState: null,
        manualOverrideUntilMs: null,
        lastScheduledCloseCycleKey: cycleKey,
        lastScheduledCloseAtMs: currentNowMs,
        updatedAtMs: currentNowMs,
      },
      db,
    );

    return {
      alreadyFinalized: false,
      cycleIdBefore,
      cycleIdAfter: cycleIdBefore + 1,
    };
  });

  return transaction();
}

function finalizePreviousCycleBeforeScheduledOpen(snapshot, currentNowMs) {
  if (!snapshot?.currentCycleKey) {
    return { alreadyFinalized: true, cycleIdBefore: null, cycleIdAfter: null, cycleKey: null };
  }

  const previousCycleKey = schedulerTimeService.addDaysToLocalDateKey(snapshot.currentCycleKey, -1);
  const result = finalizeCycleForScheduledClose(previousCycleKey, currentNowMs);
  return {
    ...result,
    cycleKey: previousCycleKey,
  };
}

async function reconcileScheduledOpen(client, snapshot, persistedState, currentNowMs) {
  finalizePreviousCycleBeforeScheduledOpen(snapshot, currentNowMs);

  const currentOpenAtMs = Number(snapshot.currentOpenAtMs);
  const lastScheduledOpenAtMs = Number(persistedState.lastScheduledOpenAtMs);
  const alreadyAppliedByTimestamp =
    Number.isFinite(currentOpenAtMs) &&
    Number.isFinite(lastScheduledOpenAtMs) &&
    lastScheduledOpenAtMs >= currentOpenAtMs;
  const alreadyApplied =
    persistedState.lastScheduledOpenCycleKey === snapshot.currentCycleKey ||
    alreadyAppliedByTimestamp;
  if (!alreadyApplied) {
    await applyOpenState(client, {
      origin: 'scheduled',
      shouldReset: false,
      cycleKey: snapshot.currentCycleKey,
    });

    schedulerStateRepository.updateState({
      currentState: 'open',
      stateOrigin: 'scheduled',
      manualOverrideState: null,
      manualOverrideUntilMs: null,
      lastScheduledOpenCycleKey: snapshot.currentCycleKey,
      lastScheduledOpenAtMs: currentNowMs,
      updatedAtMs: currentNowMs,
    });
  } else {
    await applyOpenState(client, {
      origin: 'scheduled',
      shouldReset: false,
      cycleKey: snapshot.currentCycleKey,
    });

    schedulerStateRepository.updateState({
      currentState: 'open',
      stateOrigin: 'scheduled',
      manualOverrideState: null,
      manualOverrideUntilMs: null,
      updatedAtMs: currentNowMs,
    });
  }
}

async function reconcileScheduledClose(client, currentNowMs) {
  const snapshot = getScheduleSnapshot(currentNowMs);
  const cycleKeyToFinalize = getMostRecentScheduledCloseCycleKey(snapshot);

  try {
    finalizeCycleForScheduledClose(cycleKeyToFinalize, currentNowMs);
    persistScheduledClosedState(currentNowMs);
    setRuntimeState('closed', 'scheduled', null);

    try {
      await updatePanel(client);
    } catch (panelError) {
      console.warn('Scheduler: finalização automática concluída, mas falhou ao atualizar painel:', panelError);
    }
  } catch (error) {
    setRuntimeState('closed', 'scheduled', null);
    persistScheduledClosedState(currentNowMs);

    try {
      await updatePanel(client);
    } catch (panelError) {
      console.warn('Scheduler: falha ao atualizar painel após erro de finalização automática:', panelError);
    }

    throw error;
  }
}

async function reconcileProductionState(client, options = {}) {
  if (schedulerStopped || lifecycleService.isShuttingDown() || !client) {
    return;
  }

  const currentNowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : nowMs();
  const snapshot = getScheduleSnapshot(currentNowMs);
  let persistedState = schedulerStateRepository.getState();

  if (hasActiveManualOverride(persistedState, currentNowMs)) {
    const overrideOpen = persistedState.manualOverrideState === 'open';
    if (overrideOpen) {
      await applyOpenState(client, {
        origin: 'manual_open',
        shouldReset: false,
        cycleKey: snapshot.isOpenScheduled ? snapshot.currentCycleKey : null,
      });
    } else {
      await applyClosedState(client, {
        origin: 'manual_close',
      });
    }

    scheduleProductionTransition(Number(persistedState.manualOverrideUntilMs));
    return;
  }

  if (persistedState.manualOverrideState) {
    persistedState = clearManualOverride(persistedState);
  }

  if (snapshot.isOpenScheduled) {
    await reconcileScheduledOpen(client, snapshot, persistedState, currentNowMs);
  } else {
    await reconcileScheduledClose(client, currentNowMs);
  }

  scheduleProductionTransition(snapshot.nextTransitionAtMs);
}

function getDevelopmentIntervalMs() {
  return Math.max(1, Number(config.queueTestIntervalMinutes || 5)) * 60 * 1000;
}

async function runDevelopmentOpen(client) {
  if (schedulerStopped || lifecycleService.isShuttingDown()) {
    return false;
  }

  try {
    queueService.resetQueueCycle();
  } catch (error) {
    console.error('Erro ao limpar o ciclo da fila no modo desenvolvimento:', error);
    setRuntimeState('closed', 'scheduled', null);
    return false;
  }

  setRuntimeState('open', 'scheduled', null);
  await updatePanel(client);
  console.log('Scheduler: fila aberta.');

  const delay = getDevelopmentIntervalMs();
  clearScheduledTimers();
  schedulerTimer = setTimeout(() => {
    runDevelopmentClose(client).catch((error) => {
      console.error('Erro ao fechar fila no ciclo de desenvolvimento:', error);
    });
  }, delay);

  return true;
}

async function runDevelopmentClose(client) {
  if (schedulerStopped || lifecycleService.isShuttingDown()) {
    return false;
  }

  setRuntimeState('closed', 'scheduled', null);
  await updatePanel(client);
  console.log('Scheduler: fila fechada.');

  const delay = getDevelopmentIntervalMs();
  clearScheduledTimers();
  schedulerTimer = setTimeout(() => {
    runDevelopmentOpen(client).catch((error) => {
      console.error('Erro ao reabrir fila no ciclo de desenvolvimento:', error);
    });
  }, delay);

  return true;
}

async function openQueue(client, options = {}) {
  if (schedulerStopped || lifecycleService.isShuttingDown()) {
    return false;
  }

  if (!client) {
    return false;
  }

  schedulerClient = client;

  if (isDevelopmentMode()) {
    return runDevelopmentOpen(client);
  }

  const currentNowMs = nowMs();
  const snapshot = getScheduleSnapshot(currentNowMs);
  const manualOverrideUntilMs = snapshot.nextTransitionAtMs;

  await applyOpenState(client, {
    origin: 'manual_open',
    shouldReset: Boolean(options.manual),
    cycleKey: snapshot.isOpenScheduled ? snapshot.currentCycleKey : null,
  });

  schedulerStateRepository.updateState({
    currentState: 'open',
    stateOrigin: 'manual_open',
    manualOverrideState: 'open',
    manualOverrideUntilMs,
    updatedAtMs: currentNowMs,
  });

  scheduleProductionTransition(manualOverrideUntilMs);
  return true;
}

async function closeQueue(client, _options = {}) {
  if (schedulerStopped || lifecycleService.isShuttingDown()) {
    return false;
  }

  if (!client) {
    return false;
  }

  schedulerClient = client;

  if (isDevelopmentMode()) {
    await runDevelopmentClose(client);
    return true;
  }

  const currentNowMs = nowMs();
  const snapshot = getScheduleSnapshot(currentNowMs);
  const manualOverrideUntilMs = snapshot.nextTransitionAtMs;

  await applyClosedState(client, {
    origin: 'manual_close',
  });

  schedulerStateRepository.updateState({
    currentState: 'closed',
    stateOrigin: 'manual_close',
    manualOverrideState: 'closed',
    manualOverrideUntilMs,
    updatedAtMs: currentNowMs,
  });

  scheduleProductionTransition(manualOverrideUntilMs);
  return true;
}

function startScheduler(client) {
  if (schedulerStopped || lifecycleService.isShuttingDown() || !client) {
    return;
  }

  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;
  schedulerClient = client;

  if (isDevelopmentMode()) {
    runDevelopmentOpen(client).catch((error) => {
      console.error('Erro ao iniciar ciclo de desenvolvimento:', error);
    });
    return;
  }

  reconcileProductionState(client, { reason: 'startup' }).catch((error) => {
    console.error('Erro ao iniciar scheduler em produção:', error);
    const retryDelayMs = 30_000;
    schedulerTimer = setTimeout(() => {
      reconcileProductionState(client, { reason: 'startup_retry' }).catch((retryError) => {
        console.error('Erro em tentativa de recuperação do scheduler:', retryError);
      });
    }, retryDelayMs);
  });
}

function stopScheduler() {
  if (schedulerStopped) {
    return;
  }

  schedulerStopped = true;
  schedulerStarted = false;
  clearScheduledTimers();
  setRuntimeState('closed', 'scheduled', null);
}

function resetSchedulerStopFlag() {
  schedulerStopped = false;
}

function isQueueOpen() {
  return schedulerState === 'open';
}

function getStatus() {
  if (isDevelopmentMode()) {
    return {
      mode: 'development',
      state: schedulerState,
      origin: schedulerOrigin,
      timezone: config.queueTimezone,
      configuredOpenTime: config.queueOpenTime,
      configuredCloseTime: config.queueCloseTime,
      nextOpenAt: 'imediato no ciclo atual',
      nextCloseAt: 'imediato no ciclo atual',
      currentCycleKey: null,
      testIntervalMinutes: config.queueTestIntervalMinutes,
    };
  }

  const snapshot = getScheduleSnapshot();

  return {
    mode: 'production',
    state: schedulerState,
    origin: schedulerOrigin,
    timezone: config.queueTimezone,
    configuredOpenTime: config.queueOpenTime,
    configuredCloseTime: config.queueCloseTime,
    nextOpenAt: formatDateMsInConfiguredTimezone(snapshot.nextOpenAtMs),
    nextCloseAt: formatDateMsInConfiguredTimezone(snapshot.nextCloseAtMs),
    currentCycleKey: snapshot.isOpenScheduled ? snapshot.currentCycleKey : activeCycleKey,
    testIntervalMinutes: null,
  };
}

module.exports = {
  startScheduler,
  stopScheduler,
  openQueue,
  closeQueue,
  isQueueOpen,
  getStatus,
  clearScheduledTimers,
  resetSchedulerStopFlag,
  _private: {
    getScheduleSnapshot,
    reconcileProductionState,
    scheduleProductionTransition,
    finalizeCycleForScheduledClose,
    getMostRecentScheduledCloseCycleKey,
    finalizePreviousCycleBeforeScheduledOpen,
  },
};
