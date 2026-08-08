const config = require('../config');
const queueService = require('./queueService');
const queueMessageService = require('./queueMessageService');
const lifecycleService = require('./applicationLifecycleService');
const schedulerStateRepository = require('../database/schedulerStateRepository');
const schedulerTimeService = require('./schedulerTimeService');

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

function getQueueChannel(client) {
  if (!config.queueChannelId) {
    return null;
  }
  return client.channels.cache.get(config.queueChannelId) || null;
}

async function applyChannelPermissions(client, isOpen) {
  const channel = getQueueChannel(client);
  if (!channel || !channel.isTextBased()) {
    return;
  }

  const everyoneRole = channel.guild?.roles?.everyone;
  if (!everyoneRole) {
    return;
  }

  await channel.permissionOverwrites.edit(everyoneRole.id, {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: false,
  });
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
  await applyChannelPermissions(client, true);
  await updatePanel(client);
}

async function applyClosedState(client, options = {}) {
  const origin = options.origin || 'scheduled';
  setRuntimeState('closed', origin, null);
  await applyChannelPermissions(client, false);
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

async function reconcileScheduledOpen(client, snapshot, persistedState, currentNowMs) {
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
      shouldReset: true,
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
      origin: persistedState.stateOrigin === 'manual_open' ? 'manual_open' : 'scheduled',
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
  await applyClosedState(client, {
    origin: 'scheduled',
  });

  schedulerStateRepository.updateState({
    currentState: 'closed',
    stateOrigin: 'scheduled',
    manualOverrideState: null,
    manualOverrideUntilMs: null,
    lastScheduledCloseAtMs: currentNowMs,
    updatedAtMs: currentNowMs,
  });
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
  await applyChannelPermissions(client, true);
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
  await applyChannelPermissions(client, false);
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

async function closeQueue(client, options = {}) {
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
  },
};
