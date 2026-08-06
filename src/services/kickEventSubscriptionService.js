const config = require('../config');
const kickApiServiceModule = require('./kickApiService');
const kickAppTokenServiceModule = require('./kickAppTokenService');

const DESIRED_KICK_EVENTS = Object.freeze([
  Object.freeze({ name: 'channel.subscription.new', version: 1 }),
  Object.freeze({ name: 'channel.subscription.renewal', version: 1 }),
  Object.freeze({ name: 'channel.subscription.gifts', version: 1 }),
  Object.freeze({ name: 'channel.followed', version: 1 }),
]);

class KickEventSubscriptionError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'KickEventSubscriptionError';
    this.code = code;
    this.httpStatus = options.httpStatus || 500;
    this.category = options.category || 'kick_event_subscription_error';
    this.missingVar = options.missingVar || null;
  }
}

function createEventKey(event) {
  return `${event.name}::${event.version}`;
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  if (typeof event.name !== 'string' || !event.name.trim()) {
    return null;
  }

  const version = Number(event.version);
  if (!Number.isInteger(version) || version <= 0) {
    return null;
  }

  return {
    name: event.name.trim(),
    version,
  };
}

function normalizeBroadcasterId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function mapEventsByKey(events) {
  const map = new Map();
  for (const event of events) {
    map.set(createEventKey(event), event);
  }
  return map;
}

function formatDiagnosticItem(item) {
  const versionLabel = Number.isInteger(item?.version) ? item.version : 'null';
  const subscriptionIdPresent = item?.subscriptionIdPresent ? 'sim' : 'nao';
  const errorValue = item?.error ? String(item.error) : 'none';
  return `${item?.name || 'null'} v${versionLabel} subscription_id:${subscriptionIdPresent} error:${errorValue}`;
}

function formatDiagnostics(kind, payload) {
  const status = Number.isInteger(payload?.status) ? payload.status : 'unknown';
  const message = payload?.message || 'none';
  const items = Array.isArray(payload?.diagnostics) ? payload.diagnostics : [];
  const renderedItems = items.length > 0 ? items.map((item) => formatDiagnosticItem(item)).join(' | ') : 'none';
  return `${kind} status=${status} message=${message} items=${renderedItems}`;
}

function createKickEventSubscriptionService(options = {}) {
  const cfg = options.config || config;
  const logger = options.logger || console;

  const kickApiService =
    options.kickApiService ||
    kickApiServiceModule.createKickApiService({
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      oauthBaseUrl: options.oauthBaseUrl,
      apiBaseUrl: options.apiBaseUrl,
    });

  const appTokenService =
    options.kickAppTokenService ||
    kickAppTokenServiceModule.createKickAppTokenService({
      config: cfg,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      oauthBaseUrl: options.oauthBaseUrl,
      apiBaseUrl: options.apiBaseUrl,
    });

  function requireConfigVar(value, envName) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new KickEventSubscriptionError(
        'MISSING_CONFIG',
        `Configuração obrigatória ausente: ${envName}.`,
        {
          httpStatus: 503,
          category: 'missing_config',
          missingVar: envName,
        },
      );
    }

    return value.trim();
  }

  function getBroadcasterUserId() {
    const rawId = requireConfigVar(cfg.kickBroadcasterUserId, 'KICK_BROADCASTER_USER_ID');
    const parsedId = normalizeBroadcasterId(rawId);

    if (!parsedId) {
      throw new KickEventSubscriptionError(
        'INVALID_BROADCASTER_ID',
        'KICK_BROADCASTER_USER_ID inválido. Informe um inteiro positivo.',
        {
          httpStatus: 400,
          category: 'invalid_broadcaster_id',
        },
      );
    }

    return parsedId;
  }

  function getRequiredConfig() {
    requireConfigVar(cfg.kickClientId, 'KICK_CLIENT_ID');
    requireConfigVar(cfg.kickClientSecret, 'KICK_CLIENT_SECRET');
    return {
      broadcasterUserId: getBroadcasterUserId(),
    };
  }

  async function runWithAutoRefresh(onRequest) {
    const token = await appTokenService.getAccessToken();

    try {
      return await onRequest(token);
    } catch (error) {
      if (error?.code === 'UNAUTHORIZED') {
        appTokenService.invalidateToken();

        const retryToken = await appTokenService.getAccessToken();
        return onRequest(retryToken);
      }

      throw error;
    }
  }

  function toSummaryEventLine(event) {
    return `${event.name} v${event.version}`;
  }

  async function syncDesiredEvents() {
    const { broadcasterUserId } = getRequiredConfig();

    let activeSubscriptions;
    let listResponse;
    try {
      listResponse = await runWithAutoRefresh((accessToken) =>
        kickApiService.listEventSubscriptions({
          accessToken,
          broadcasterUserId,
        }),
      );

      activeSubscriptions = listResponse.subscriptions;
      if (typeof logger?.info === 'function') {
        logger.info(`Kick events sync diagnostics: ${formatDiagnostics('GET', listResponse)}`);
      }
    } catch (error) {
      if (typeof logger?.warn === 'function') {
        logger.warn(
          `Kick events sync: falha ao listar subscriptions (${error?.code || 'unknown_error'})`,
        );
      }
      throw error;
    }

    const activeEventKeys = new Set(
      activeSubscriptions
        .filter((subscription) => Number(subscription.broadcasterUserId) === broadcasterUserId)
        .map((subscription) => createEventKey(subscription)),
    );

    const alreadyActive = [];
    const missingEvents = [];

    for (const desiredEvent of DESIRED_KICK_EVENTS) {
      if (activeEventKeys.has(createEventKey(desiredEvent))) {
        alreadyActive.push(toSummaryEventLine(desiredEvent));
      } else {
        missingEvents.push(desiredEvent);
      }
    }

    if (missingEvents.length === 0) {
      return {
        alreadyActive,
        created: [],
        failed: [],
      };
    }

    let createdResponse;
    try {
      createdResponse = await runWithAutoRefresh((accessToken) =>
        kickApiService.createEventSubscriptions({
          accessToken,
          broadcasterUserId,
          events: missingEvents,
        }),
      );
      if (typeof logger?.info === 'function') {
        logger.info(`Kick events sync diagnostics: ${formatDiagnostics('POST', createdResponse)}`);
      }
    } catch (error) {
      if (typeof logger?.warn === 'function') {
        logger.warn(
          `Kick events sync: falha ao criar subscriptions (${error?.code || 'unknown_error'})`,
        );
      }

      return {
        alreadyActive,
        created: [],
        failed: missingEvents.map((event) => ({
          event: toSummaryEventLine(event),
          reason: error?.code || 'upstream_error',
        })),
      };
    }

    const requestedByKey = mapEventsByKey(missingEvents);
    const resultByKey = new Map();
    for (const item of createdResponse.results || []) {
      if (!item?.name || !Number.isInteger(item?.version)) {
        continue;
      }
      resultByKey.set(createEventKey(item), item);
    }

    const created = [];
    const failed = [];

    for (const [eventKey, event] of requestedByKey.entries()) {
      const responseItem = resultByKey.get(eventKey);
      if (!responseItem) {
        failed.push({
          event: toSummaryEventLine(event),
          reason: createdResponse?.message || 'not_confirmed',
        });
        continue;
      }

      if (responseItem.error) {
        failed.push({
          event: toSummaryEventLine(event),
          reason: responseItem.error,
        });
        continue;
      }

      if (responseItem.confirmed) {
        created.push(toSummaryEventLine(event));
      } else {
        failed.push({
          event: toSummaryEventLine(event),
          reason: createdResponse?.message || 'not_confirmed',
        });
      }
    }

    return {
      alreadyActive,
      created,
      failed,
    };
  }

  return {
    DESIRED_KICK_EVENTS,
    normalizeEvent,
    syncDesiredEvents,
  };
}

const defaultService = createKickEventSubscriptionService();
defaultService.createKickEventSubscriptionService = createKickEventSubscriptionService;
defaultService.KickEventSubscriptionError = KickEventSubscriptionError;
defaultService.DESIRED_KICK_EVENTS = DESIRED_KICK_EVENTS;

module.exports = defaultService;
