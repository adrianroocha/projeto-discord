const { ChannelType } = require('discord.js');
const config = require('../config');
const adminCommandAuditLogsRepository = require('../database/adminCommandAuditLogsRepository');
const adminAuditTargetPresenter = require('./adminAuditTargetPresenter');

const ADMIN_AUDIT_STATUSES = new Set(['pending', 'success', 'failed', 'denied']);

function nowMs() {
  return Date.now();
}

function normalizeErrorCode(value, fallback = 'INTERNAL_ERROR') {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 80);
}

function sanitizeText(value, fallback = 'unknown', maxLength = 120) {
  const normalized = String(value || '')
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ');

  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, maxLength);
}

function sanitizeJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const sensitiveKeyPattern = /(token|secret|password|authorization|oauth|stack|trace|exception|payload|raw|message)/i;
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = sanitizeText(key, '', 60);
    if (!safeKey) {
      continue;
    }

    if (sensitiveKeyPattern.test(safeKey)) {
      continue;
    }

    if (raw === null || raw === undefined) {
      continue;
    }

    if (typeof raw === 'number') {
      if (Number.isFinite(raw)) {
        output[safeKey] = Math.trunc(raw);
      }
      continue;
    }

    if (typeof raw === 'boolean') {
      output[safeKey] = raw;
      continue;
    }

    if (typeof raw === 'string') {
      const sanitizedValue = sanitizeText(raw, '', 200);
      if (!sensitiveKeyPattern.test(sanitizedValue)) {
        output[safeKey] = sanitizedValue;
      }
      continue;
    }

    if (Array.isArray(raw)) {
      output[safeKey] = raw
        .slice(0, 30)
        .map((item) => (typeof item === 'string' ? sanitizeText(item, '', 120) : item))
        .filter((item) => item !== null && item !== undefined && item !== '');
      continue;
    }

    if (typeof raw === 'object') {
      output[safeKey] = sanitizeJsonObject(raw);
    }
  }

  return output;
}

function getSafeActorUsername(interaction) {
  const direct = sanitizeText(interaction?.user?.username, '', 80);
  if (direct) {
    return direct;
  }

  const globalName = sanitizeText(interaction?.user?.globalName, '', 80);
  if (globalName) {
    return globalName;
  }

  return 'unknown';
}

function safeQueueCycleId(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function getSafeStateSummary(rawState) {
  if (!rawState || typeof rawState !== 'object') {
    return null;
  }

  const summary = {};
  if (typeof rawState.mode === 'string') {
    summary.mode = sanitizeText(rawState.mode, '', 24);
  }
  if (typeof rawState.state === 'string') {
    summary.state = sanitizeText(rawState.state, '', 24);
  }
  if (typeof rawState.origin === 'string') {
    summary.origin = sanitizeText(rawState.origin, '', 40);
  }
  if (typeof rawState.currentCycleKey === 'string') {
    summary.currentCycleKey = sanitizeText(rawState.currentCycleKey, '', 32);
  }

  return Object.keys(summary).length ? summary : null;
}

function formatTimestampForLog(valueMs, timezone) {
  const value = Number(valueMs);
  if (!Number.isFinite(value)) {
    return 'indisponivel';
  }

  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone || 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

function mapResultLabel(result) {
  if (result === 'success') {
    return 'sucesso';
  }
  if (result === 'denied') {
    return 'recusada';
  }
  if (result === 'failed') {
    return 'falha';
  }
  return 'pendente';
}

function safeParseJson(rawValue) {
  try {
    const parsed = JSON.parse(rawValue || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Falha de formatação nunca pode impedir a publicação nem a operação administrativa.
function buildSafeTargetLines(record) {
  try {
    return adminAuditTargetPresenter.buildAuditTargetLines({
      commandName: record.commandName,
      nextState: safeParseJson(record.nextStateJson),
      parameters: safeParseJson(record.parametersJson),
    });
  } catch {
    return [];
  }
}

function buildEffectSummary(record) {
  const command = record.commandName;
  const previousState = safeParseJson(record.previousStateJson);
  const nextState = safeParseJson(record.nextStateJson);

  if (command === 'scheduler-open') {
    return 'fila aberta; ciclo reiniciado';
  }

  if (command === 'scheduler-close') {
    return 'fila fechada; ciclo atual preservado';
  }

  if (command === 'lobby-form-force') {
    const requested = Number(nextState.requestedQuantity || 0);
    const used = Number(nextState.playersUsed || 0);
    return `lobby em formacao criada (${used}/${requested} jogadores)`;
  }

  if (command === 'lobby-start') {
    const lobbyNumber = Number(nextState.lobbyNumber || previousState.lobbyNumber || 0);
    if (lobbyNumber > 0) {
      return `lobby #${lobbyNumber} iniciada`;
    }
    return 'lobby iniciada';
  }

  return 'acao administrativa executada';
}

function createAdminCommandAuditService(options = {}) {
  const cfg = options.config || config;
  const repository = options.repository || adminCommandAuditLogsRepository;
  const logger = options.logger || console;
  const now = options.now || nowMs;

  function logWarn(message) {
    if (typeof logger?.warn === 'function') {
      logger.warn(message);
    }
  }

  function createAuditContext(interaction, payload = {}) {
    const providedInteractionId = sanitizeText(payload.interactionId || interaction?.id, '', 120);
    const interactionId = providedInteractionId || `synthetic-${now()}-${Math.trunc(Math.random() * 1000000)}`;
    const commandName = sanitizeText(payload.commandName || interaction?.commandName, '', 80);

    return {
      interactionId,
      commandName,
      guildId: sanitizeText(interaction?.guildId, '', 40) || null,
      channelId: sanitizeText(interaction?.channelId, '', 40) || null,
      actorDiscordId: sanitizeText(interaction?.user?.id, 'unknown', 60),
      actorUsername: getSafeActorUsername(interaction),
      parameters: sanitizeJsonObject(payload.parameters || {}),
      queueCycleId: safeQueueCycleId(payload.queueCycleId),
      previousState: getSafeStateSummary(payload.previousState),
      startedAtMs: now(),
      createdAtMs: now(),
    };
  }

  function createFinalizePayload(payload = {}, result) {
    const finishedAtMs = now();

    return {
      result,
      errorCode: payload.errorCode ? normalizeErrorCode(payload.errorCode) : result === 'success' ? 'OK' : null,
      queueCycleId: safeQueueCycleId(payload.queueCycleId),
      previousState: getSafeStateSummary(payload.previousState),
      nextState: sanitizeJsonObject(payload.nextState || {}),
      finishedAtMs,
    };
  }

  async function beginRequired(interaction, payload = {}) {
    const context = createAuditContext(interaction, payload);

    if (!context.commandName) {
      const error = new Error('Dados obrigatórios de auditoria ausentes.');
      error.code = 'AUDIT_REQUIRED_UNAVAILABLE';
      throw error;
    }

    let entry;
    try {
      entry = repository.registerPending(context);
    } catch {
      const error = new Error('Falha ao registrar auditoria administrativa obrigatória.');
      error.code = 'AUDIT_REQUIRED_UNAVAILABLE';
      throw error;
    }

    if (!entry.wasCreated) {
      const duplicateError = new Error('Interação administrativa já registrada anteriormente.');
      duplicateError.code = 'DUPLICATE_INTERACTION';
      throw duplicateError;
    }

    return {
      auditId: entry.id,
      interactionId: context.interactionId,
      actorUsername: context.actorUsername,
      actorDiscordId: context.actorDiscordId,
      commandName: context.commandName,
      guildId: context.guildId,
      startedAtMs: entry.startedAtMs,
    };
  }

  async function beginBestEffort(interaction, payload = {}) {
    try {
      return await beginRequired(interaction, payload);
    } catch {
      return null;
    }
  }

  async function withTimeout(promise, timeoutMs) {
    const limitMs = Math.max(100, Number(timeoutMs) || 2000);
    let timer = null;

    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), limitMs);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    });

    const result = await Promise.race([promise, timeoutPromise]);
    if (timer) {
      clearTimeout(timer);
    }

    return result;
  }

  async function publishDiscordSummary(record) {
    if (!cfg.adminAuditChannelId) {
      return { sent: false, reason: 'channel_not_configured' };
    }

    const client = record && record.client;
    if (!client || !client.channels || typeof client.channels.fetch !== 'function') {
      return { sent: false, reason: 'client_unavailable' };
    }

    let channel;
    try {
      channel = await client.channels.fetch(cfg.adminAuditChannelId);
    } catch {
      return { sent: false, reason: 'channel_fetch_failed' };
    }

    if (!channel || !channel.isTextBased()) {
      return { sent: false, reason: 'invalid_channel' };
    }

    if (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) {
      return { sent: false, reason: 'not_guild_text_channel' };
    }

    if (cfg.guildId && channel.guildId !== cfg.guildId) {
      return { sent: false, reason: 'channel_guild_mismatch' };
    }

    const finalizedAtMs = Number(record.finishedAtMs || now());
    const dateLabel = formatTimestampForLog(finalizedAtMs, 'America/Sao_Paulo');

    const targetLines = buildSafeTargetLines(record);
    const actorDiscordId = adminAuditTargetPresenter.isDiscordSnowflake(String(record.actorDiscordId || ''))
      ? String(record.actorDiscordId).trim()
      : null;

    const lines = [];
    lines.push(record.result === 'success' ? 'Acao administrativa' : 'Acao administrativa nao concluida');
    lines.push(`Moderador: ${record.actorUsername}`);
    if (actorDiscordId) {
      lines.push(`ID do moderador: ${actorDiscordId}`);
    }
    lines.push(`Comando: /${record.commandName}`);
    lines.push(...targetLines);
    lines.push(`Resultado: ${mapResultLabel(record.result)}`);
    if (record.result === 'success') {
      lines.push(`Efeito: ${buildEffectSummary(record)}`);
    } else if (record.errorCode) {
      lines.push(`Codigo: ${normalizeErrorCode(record.errorCode)}`);
    }
    lines.push(`Data: ${dateLabel}`);

    await channel.send({
      content: adminAuditTargetPresenter.capDiscordContent(lines.join('\n')),
      allowedMentions: {
        parse: [],
        users: [],
        roles: [],
      },
    });

    return { sent: true };
  }

  async function finalize(context, result, payload = {}) {
    if (!context || !context.auditId) {
      return { auditSaved: false, auditWarning: 'audit_context_missing' };
    }

    if (!ADMIN_AUDIT_STATUSES.has(result)) {
      return { auditSaved: false, auditWarning: 'audit_invalid_result' };
    }

    let stored;
    const finalizePayload = createFinalizePayload(payload, result);
    try {
      stored = repository.finalizeById(context.auditId, finalizePayload);
    } catch {
      logWarn(`Admin command audit finalize warning code=${normalizeErrorCode(payload.errorCode || 'AUDIT_FINALIZE_FAILED')}`);
      return { auditSaved: false, auditWarning: 'audit_finalize_failed' };
    }

    if (!stored) {
      logWarn('Admin command audit finalize warning code=AUDIT_FINALIZE_MISSING_ROW');
      return { auditSaved: false, auditWarning: 'audit_finalize_missing_row' };
    }

    const notifyResult = await withTimeout(
      publishDiscordSummary({
        ...stored,
        actorUsername: context.actorUsername,
        commandName: context.commandName,
        client: payload.client,
      }),
      2000,
    );

    if (!notifyResult || notifyResult.timedOut) {
      logWarn('Admin command audit warning code=AUDIT_DISCORD_NOTIFY_TIMEOUT');
      return { auditSaved: true, auditWarning: 'discord_notify_timeout' };
    }

    if (notifyResult.sent !== true) {
      logWarn(`Admin command audit warning code=${normalizeErrorCode(notifyResult.reason || 'DISCORD_NOTIFY_FAILED')}`);
      return { auditSaved: true, auditWarning: 'discord_notify_failed' };
    }

    return { auditSaved: true };
  }

  async function finishSuccess(context, payload = {}) {
    return finalize(context, 'success', {
      ...payload,
      errorCode: 'OK',
    });
  }

  async function finishFailed(context, payload = {}) {
    return finalize(context, 'failed', {
      ...payload,
      errorCode: normalizeErrorCode(payload.errorCode, 'INTERNAL_ERROR'),
    });
  }

  async function finishDenied(context, payload = {}) {
    return finalize(context, 'denied', {
      ...payload,
      errorCode: normalizeErrorCode(payload.errorCode, 'MISSING_PERMISSION'),
    });
  }

  return {
    normalizeErrorCode,
    beginRequired,
    beginBestEffort,
    finishSuccess,
    finishFailed,
    finishDenied,
  };
}

const defaultService = createAdminCommandAuditService();
defaultService.createAdminCommandAuditService = createAdminCommandAuditService;

defaultService.normalizeErrorCode = normalizeErrorCode;

module.exports = defaultService;
