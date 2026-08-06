const { getDatabase } = require('../database/sqliteClient');
const config = require('../config');
const kickSubscriptionsRepository = require('../database/kickSubscriptionsRepository');
const kickWebhookEventsRepository = require('../database/kickWebhookEventsRepository');
const kickFollowEventsRepository = require('../database/kickFollowEventsRepository');

const SUPPORTED_EVENT_TYPES = new Set([
  'channel.subscription.new',
  'channel.subscription.renewal',
  'channel.subscription.gifts',
  'channel.followed',
]);

function createProcessingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Campo inválido: ${fieldName} é obrigatório.`);
  }
  return value.trim();
}

function toUserIdString(value, fieldName) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw createProcessingError('invalid_follower', `Campo inválido: ${fieldName} deve ser positivo.`);
    }
    return String(Math.trunc(value));
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  throw createProcessingError('invalid_follower', `Campo inválido: ${fieldName} é obrigatório.`);
}

function createKickSubscriptionEventService(options = {}) {
  const cfg = options.config || config;
  const repository = options.kickSubscriptionsRepository || kickSubscriptionsRepository;
  const eventsRepository = options.kickWebhookEventsRepository || kickWebhookEventsRepository;
  const followEventsRepository = options.kickFollowEventsRepository || kickFollowEventsRepository;
  const logger = options.logger || console;
  const now = options.now || (() => Date.now());
  const getDb = options.getDb || (() => getDatabase());

  function isBroadcasterConfigured() {
    return typeof cfg.kickBroadcasterUserId === 'string' && cfg.kickBroadcasterUserId.trim() !== '';
  }

  function parseSubscriptionPayload(payload, eventType) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Payload de webhook inválido.');
    }

    const broadcasterUserId = toNonEmptyString(payload?.broadcaster?.user_id, 'broadcaster.user_id');

    if (eventType === 'channel.subscription.gifts') {
      if (!Array.isArray(payload.giftees)) {
        throw new Error('Payload inválido: giftees é obrigatório para gifts.');
      }

      const grants = payload.giftees.map((giftee, index) => ({
        broadcasterUserId,
        kickUserId: toNonEmptyString(giftee?.user_id, `giftees[${index}].user_id`),
        kickUsername: toNonEmptyString(giftee?.username, `giftees[${index}].username`),
        startedAtIso: toNonEmptyString(payload.created_at, 'created_at'),
        expiresAtIso: toNonEmptyString(payload.expires_at, 'expires_at'),
        subscriptionType: 'gifted',
      }));

      return {
        broadcasterUserId,
        grants,
      };
    }

    return {
      broadcasterUserId,
      grants: [
        {
          broadcasterUserId,
          kickUserId: toNonEmptyString(payload?.subscriber?.user_id, 'subscriber.user_id'),
          kickUsername: toNonEmptyString(payload?.subscriber?.username, 'subscriber.username'),
          startedAtIso: toNonEmptyString(payload.created_at, 'created_at'),
          expiresAtIso: toNonEmptyString(payload.expires_at, 'expires_at'),
          subscriptionType: 'direct',
        },
      ],
    };
  }

  function parseFollowPayload(payload, eventTimestamp) {
    if (!payload || typeof payload !== 'object') {
      throw createProcessingError('invalid_follower', 'Payload de webhook inválido.');
    }

    const broadcasterUserId = toUserIdString(payload?.broadcaster?.user_id, 'broadcaster.user_id');
    const followerUserId = toUserIdString(payload?.follower?.user_id, 'follower.user_id');
    const followerUsername = toNonEmptyString(payload?.follower?.username, 'follower.username');

    const followedAtMs = Date.parse(eventTimestamp);
    if (!Number.isFinite(followedAtMs)) {
      throw createProcessingError(
        'invalid_event_timestamp',
        'Campo inválido: eventTimestamp deve ser data RFC3339 válida.',
      );
    }

    return {
      broadcasterUserId,
      followerUserId,
      followerUsername,
      followedAtMs: Math.trunc(followedAtMs),
    };
  }

  function shouldIgnoreBroadcaster(broadcasterUserId) {
    return Boolean(
      cfg.kickBroadcasterUserId && String(cfg.kickBroadcasterUserId) !== String(broadcasterUserId),
    );
  }

  function processEvent(payload) {
    const db = getDb();
    const timestampNow = now();

    try {
      const eventMessageId = toNonEmptyString(payload?.eventHeaders?.eventMessageId, 'eventMessageId');
      const eventSubscriptionId = toNonEmptyString(
        payload?.eventHeaders?.eventSubscriptionId,
        'eventSubscriptionId',
      );
      const eventType = toNonEmptyString(payload?.eventHeaders?.eventType, 'eventType');
      const eventVersion = toNonEmptyString(payload?.eventHeaders?.eventVersion, 'eventVersion');
      const eventTimestamp = toNonEmptyString(payload?.eventHeaders?.eventTimestamp, 'eventTimestamp');

      const transaction = db.transaction(() => {
        if (eventsRepository.hasProcessed(eventMessageId, db)) {
          return { status: 'duplicate', appliedCount: 0 };
        }

        if (!SUPPORTED_EVENT_TYPES.has(eventType)) {
          eventsRepository.registerProcessedEvent(
            {
              eventMessageId,
              eventSubscriptionId,
              eventType,
              eventVersion,
              eventTimestamp,
              receivedAtMs: timestampNow,
              processedAtMs: timestampNow,
            },
            db,
          );
          return { status: 'ignored_unsupported', appliedCount: 0 };
        }

        if (!isBroadcasterConfigured()) {
          if (typeof logger?.warn === 'function') {
            logger.warn('Webhook Kick desabilitado: configuração incompleta para broadcaster.');
          }
          return { status: 'webhook_disabled_unconfigured', appliedCount: 0 };
        }

        const parsed =
          eventType === 'channel.followed'
            ? parseFollowPayload(payload.eventPayload, eventTimestamp)
            : parseSubscriptionPayload(payload.eventPayload, eventType);
        if (shouldIgnoreBroadcaster(parsed.broadcasterUserId)) {
          if (typeof logger?.warn === 'function') {
            logger.warn('Kick webhook ignorado: broadcaster diferente do configurado.');
          }

          eventsRepository.registerProcessedEvent(
            {
              eventMessageId,
              eventSubscriptionId,
              eventType,
              eventVersion,
              eventTimestamp,
              receivedAtMs: timestampNow,
              processedAtMs: timestampNow,
            },
            db,
          );
          return { status: 'ignored_other_broadcaster', appliedCount: 0 };
        }

        if (eventType === 'channel.followed') {
          const recordedEvent = eventsRepository.registerProcessedEvent(
            {
              eventMessageId,
              eventSubscriptionId,
              eventType,
              eventVersion,
              eventTimestamp,
              receivedAtMs: timestampNow,
              processedAtMs: timestampNow,
            },
            db,
          );

          if (!recordedEvent.recorded) {
            return { status: 'duplicate', appliedCount: 0 };
          }

          followEventsRepository.registerFollowEvent(
            {
              eventMessageId,
              broadcasterUserId: parsed.broadcasterUserId,
              followerUserId: parsed.followerUserId,
              followerUsername: parsed.followerUsername,
              followedAtMs: parsed.followedAtMs,
              receivedAtMs: timestampNow,
            },
            db,
          );

          return { status: 'processed', appliedCount: 1 };
        }

        for (const grant of parsed.grants) {
          repository.upsertFromEvent(
            {
              broadcasterUserId: grant.broadcasterUserId,
              kickUserId: grant.kickUserId,
              kickUsername: grant.kickUsername,
              subscriptionType: grant.subscriptionType,
              startedAtIso: grant.startedAtIso,
              expiresAtIso: grant.expiresAtIso,
              lastEventMessageId: eventMessageId,
              updatedAtMs: timestampNow,
            },
            db,
          );
        }

        const recordedEvent = eventsRepository.registerProcessedEvent(
          {
            eventMessageId,
            eventSubscriptionId,
            eventType,
            eventVersion,
            eventTimestamp,
            receivedAtMs: timestampNow,
            processedAtMs: timestampNow,
          },
          db,
        );

        if (!recordedEvent.recorded) {
          return { status: 'duplicate', appliedCount: 0 };
        }

        return { status: 'processed', appliedCount: parsed.grants.length };
      });

      return transaction();
    } catch (error) {
      if (error?.code === 'invalid_event_timestamp' || error?.code === 'invalid_follower') {
        throw error;
      }

      if (error?.message && /eventTimestamp/.test(error.message)) {
        throw createProcessingError('invalid_event_timestamp', 'Timestamp do evento inválido.');
      }

      if (error?.message && /follower\.|broadcaster\.user_id/.test(error.message)) {
        throw createProcessingError('invalid_follower', 'Follower ou broadcaster inválido no webhook.');
      }

      throw createProcessingError('database_error', 'Falha ao persistir webhook da Kick.');
    }
  }

  return {
    processEvent,
  };
}

const defaultService = createKickSubscriptionEventService();
defaultService.createKickSubscriptionEventService = createKickSubscriptionEventService;

module.exports = defaultService;
