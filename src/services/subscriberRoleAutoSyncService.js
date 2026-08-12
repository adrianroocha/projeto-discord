const subscriberRoleSyncService = require('./subscriberRoleSyncService');

const ALLOWED_TRIGGER_TYPES = new Set([
  'manual_grant',
  'manual_grant_extend',
  'manual_revoke',
  'kick_link',
  'kick_unlink',
  'kick_subscription_new',
  'kick_subscription_renewal',
  'kick_subscription_gift',
]);

function normalizeDiscordId(discordId) {
  return typeof discordId === 'string' ? discordId.trim() : '';
}

function normalizeTriggerType(triggerType) {
  if (typeof triggerType !== 'string') {
    return 'unknown';
  }

  const normalized = triggerType.trim();
  if (!normalized) {
    return 'unknown';
  }

  if (!ALLOWED_TRIGGER_TYPES.has(normalized)) {
    return 'unknown';
  }

  return normalized;
}

function normalizeReason(reason) {
  if (typeof reason !== 'string') {
    return 'Sem motivo informado';
  }

  const normalized = reason.trim();
  return normalized || 'Sem motivo informado';
}

function normalizeTriggeredByDiscordId(triggeredByDiscordId) {
  if (typeof triggeredByDiscordId !== 'string') {
    return 'system';
  }

  const normalized = triggeredByDiscordId.trim();
  return normalized || 'system';
}

function normalizeSyncOutcome(syncResult) {
  const resultCode = typeof syncResult?.result === 'string' ? syncResult.result : 'unknown_result';
  const action = typeof syncResult?.action === 'string' ? syncResult.action : 'not_altered';

  let roleState = 'pending';
  if (action === 'role_added') {
    roleState = 'added';
  } else if (action === 'role_removed') {
    roleState = 'removed';
  } else if (action === 'already_correct') {
    roleState = 'kept';
  }

  const pending = !['added', 'removed', 'kept'].includes(roleState);

  return {
    roleState,
    resultCode,
    action,
    pending,
  };
}

function createSubscriberRoleAutoSyncService(options = {}) {
  const syncService = options.subscriberRoleSyncService || subscriberRoleSyncService;
  const logger = options.logger || console;

  async function syncAfterEligibilityChange(input = {}) {
    const discordId = normalizeDiscordId(input.discordId);
    const triggerType = normalizeTriggerType(input.triggerType);
    const reason = normalizeReason(input.reason);
    const triggeredByDiscordId = normalizeTriggeredByDiscordId(input.triggeredByDiscordId);

    if (!discordId) {
      if (typeof logger?.warn === 'function') {
        logger.warn('SUB auto sync ignorado: discordId inválido.');
      }

      return {
        ok: false,
        status: 'warning',
        warning: 'invalid_discord_id',
        discordId: null,
        triggerType,
        reason,
        eligibility: null,
        sources: { kick: false, manual: false },
        roleState: 'pending',
        resultCode: 'invalid_discord_id',
      };
    }

    try {
      const syncResult = await syncService.syncUser(discordId, {
        client: input.client,
        triggeredByDiscordId,
        triggerType,
        reason,
      });

      const outcome = normalizeSyncOutcome(syncResult);

      if (outcome.pending) {
        if (typeof logger?.warn === 'function') {
          logger.warn(
            `SUB auto sync pendente: trigger=${triggerType} discordId=${discordId} result=${outcome.resultCode}`,
          );
        }
      } else if (typeof logger?.info === 'function') {
        logger.info(
          `SUB auto sync concluído: trigger=${triggerType} discordId=${discordId} roleState=${outcome.roleState}`,
        );
      }

      return {
        ok: !outcome.pending,
        status: outcome.pending ? 'warning' : 'synced',
        warning: outcome.pending ? 'sync_pending' : null,
        discordId,
        triggerType,
        reason,
        eligibility: syncResult?.eligibility ?? null,
        sources: {
          kick: Boolean(syncResult?.sources?.kick),
          manual: Boolean(syncResult?.sources?.manual),
        },
        roleState: outcome.roleState,
        resultCode: outcome.resultCode,
        action: outcome.action,
      };
    } catch {
      if (typeof logger?.warn === 'function') {
        logger.warn(
          `SUB auto sync falhou sem comprometer fluxo principal: trigger=${triggerType} discordId=${discordId}`,
        );
      }

      return {
        ok: false,
        status: 'warning',
        warning: 'sync_unavailable',
        discordId,
        triggerType,
        reason,
        eligibility: null,
        sources: { kick: false, manual: false },
        roleState: 'pending',
        resultCode: 'unexpected_error',
        action: 'not_altered',
      };
    }
  }

  return {
    syncAfterEligibilityChange,
    ALLOWED_TRIGGER_TYPES,
  };
}

const defaultService = createSubscriberRoleAutoSyncService();
defaultService.createSubscriberRoleAutoSyncService = createSubscriberRoleAutoSyncService;

defaultService.ALLOWED_TRIGGER_TYPES = ALLOWED_TRIGGER_TYPES;

module.exports = defaultService;
