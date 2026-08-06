const { PermissionsBitField } = require('discord.js');
const config = require('../config');
const queueService = require('./queueService');
const queueMessageService = require('./queueMessageService');

let schedulerState = 'closed';
let schedulerTimer = null;
let schedulerLoopTimer = null;
let currentOpenTimer = null;
let currentCloseTimer = null;
let currentCycle = null;

function isDevelopmentMode() {
  return config.nodeEnv === 'development';
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

function clearScheduledTimers() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  if (schedulerLoopTimer) {
    clearTimeout(schedulerLoopTimer);
    schedulerLoopTimer = null;
  }
  if (currentOpenTimer) {
    clearTimeout(currentOpenTimer);
    currentOpenTimer = null;
  }
  if (currentCloseTimer) {
    clearTimeout(currentCloseTimer);
    currentCloseTimer = null;
  }
}

function parseTimeToDate(targetTime, referenceDate = new Date()) {
  const [hours, minutes] = targetTime.split(':').map(Number);
  const date = new Date(referenceDate);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function getNextProductionSchedule() {
  const now = new Date();
  const openTime = parseTimeToDate(config.queueOpenTime, now);
  const closeTime = parseTimeToDate(config.queueCloseTime, now);

  if (now < openTime) {
    return { nextOpenAt: openTime, nextCloseAt: closeTime < openTime ? new Date(openTime.getTime() + 24 * 60 * 60 * 1000) : closeTime };
  }

  const nextOpen = new Date(openTime.getTime() + 24 * 60 * 60 * 1000);
  const nextClose = closeTime < openTime ? new Date(closeTime.getTime() + 24 * 60 * 60 * 1000) : closeTime;

  return { nextOpenAt: nextOpen, nextCloseAt: nextClose };
}

function getNextDevelopmentCycle() {
  const intervalMs = Math.max(1, Number(config.queueTestIntervalMinutes || 5)) * 60 * 1000;
  const now = Date.now();
  return {
    openAt: now,
    closeAt: now + intervalMs,
    intervalMs,
  };
}

async function updatePanel(client) {
  await queueMessageService.updatePanel(client, { isQueueOpen: schedulerState === 'open' });
}

async function openQueue(client, options = {}) {
  const manual = !!options.manual;
  clearScheduledTimers();

  try {
    queueService.resetQueueCycle();
  } catch (error) {
    console.error('Erro ao limpar o ciclo da fila:', error);
    schedulerState = 'closed';
    return false;
  }

  schedulerState = 'open';
  await applyChannelPermissions(client, true);
  await updatePanel(client);
  console.log('Scheduler: fila aberta.');

  if (isDevelopmentMode()) {
    const { closeAt } = getNextDevelopmentCycle();
    currentCloseTimer = setTimeout(() => {
      closeQueue(client).catch((error) => console.error('Erro ao fechar fila no ciclo de desenvolvimento:', error));
    }, Math.max(1, closeAt - Date.now()));
    currentOpenTimer = null;
    currentCycle = { mode: 'development', openAt: Date.now(), closeAt };
    return;
  }

  const nextCloseAt = getNextProductionSchedule().nextCloseAt;
  currentCloseTimer = setTimeout(() => {
    closeQueue(client).catch((error) => console.error('Erro ao fechar fila em produção:', error));
  }, Math.max(1, nextCloseAt - Date.now()));
  currentCycle = { mode: 'production', openAt: Date.now(), closeAt: nextCloseAt.getTime() };

  if (!manual) {
    const nextOpenAt = getNextProductionSchedule().nextOpenAt;
    currentOpenTimer = setTimeout(() => {
      openQueue(client).catch((error) => console.error('Erro ao reabrir fila em produção:', error));
    }, Math.max(1, nextOpenAt - Date.now()));
  }
}

async function closeQueue(client, options = {}) {
  const manual = !!options.manual;
  clearScheduledTimers();
  schedulerState = 'closed';
  await applyChannelPermissions(client, false);
  await updatePanel(client);
  console.log('Scheduler: fila fechada.');

  if (isDevelopmentMode()) {
    const { intervalMs } = getNextDevelopmentCycle();
    schedulerLoopTimer = setTimeout(() => {
      openQueue(client).catch((error) => console.error('Erro ao reabrir fila em desenvolvimento:', error));
    }, intervalMs);
    currentCycle = { mode: 'development', openAt: Date.now(), closeAt: Date.now() + intervalMs };
    return;
  }

  if (!manual) {
    const nextOpenAt = getNextProductionSchedule().nextOpenAt;
    schedulerTimer = setTimeout(() => {
      openQueue(client).catch((error) => console.error('Erro ao reabrir fila em produção:', error));
    }, Math.max(1, nextOpenAt - Date.now()));
  }
}

function startScheduler(client) {
  if (schedulerState !== 'closed' || schedulerTimer || schedulerLoopTimer || currentOpenTimer || currentCloseTimer) {
    return;
  }

  if (isDevelopmentMode()) {
    openQueue(client).catch((error) => console.error('Erro ao iniciar ciclo de desenvolvimento:', error));
    return;
  }

  const { nextOpenAt, nextCloseAt } = getNextProductionSchedule();
  const now = Date.now();
  const openDelay = Math.max(1, nextOpenAt.getTime() - now);
  schedulerTimer = setTimeout(() => {
    openQueue(client).catch((error) => console.error('Erro ao abrir fila em produção:', error));
  }, openDelay);
}

function isQueueOpen() {
  return schedulerState === 'open';
}

function getStatus() {
  return {
    mode: isDevelopmentMode() ? 'development' : 'production',
    state: schedulerState,
    nextOpenAt: isDevelopmentMode() ? 'imediato no ciclo atual' : new Date(getNextProductionSchedule().nextOpenAt).toLocaleString('pt-BR', { timeZone: config.queueTimezone }),
    nextCloseAt: isDevelopmentMode() ? 'imediato no ciclo atual' : new Date(getNextProductionSchedule().nextCloseAt).toLocaleString('pt-BR', { timeZone: config.queueTimezone }),
    testIntervalMinutes: isDevelopmentMode() ? config.queueTestIntervalMinutes : null,
  };
}

module.exports = {
  startScheduler,
  openQueue,
  closeQueue,
  isQueueOpen,
  getStatus,
};
