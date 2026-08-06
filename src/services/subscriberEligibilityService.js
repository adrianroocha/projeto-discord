const config = require('../config');
const kickAccountsRepository = require('../database/kickAccountsRepository');
const kickSubscriptionsRepository = require('../database/kickSubscriptionsRepository');
const manualSubGrantService = require('./manualSubGrantService');

function normalizeDiscordId(discordId) {
  if (typeof discordId !== 'string' || !discordId.trim()) {
    throw new Error('discordId inválido.');
  }
  return discordId.trim();
}

function normalizeNowMs(nowMs, nowFn) {
  if (nowMs !== undefined && nowMs !== null) {
    const parsed = Number(nowMs);
    if (!Number.isFinite(parsed)) {
      throw new Error('nowMs inválido.');
    }
    return Math.trunc(parsed);
  }

  return Math.trunc(nowFn());
}

function normalizeBroadcasterId(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return null;
  }

  return rawValue.trim();
}

function mapManualSource(status) {
  if (!status || !status.active) {
    return {
      active: false,
      reason: null,
      grantedByDiscordId: null,
      grantedAtMs: null,
      expiresAtMs: null,
    };
  }

  return {
    active: true,
    reason: status.active.reason,
    grantedByDiscordId: status.active.grantedByDiscordId,
    grantedAtMs: status.active.grantedAtMs,
    expiresAtMs: status.active.expiresAtMs,
  };
}

function createSubscriberEligibilityService(options = {}) {
  const cfg = options.config || config;
  const now = options.now || (() => Date.now());

  const accountsRepository =
    options.kickAccountsRepository || kickAccountsRepository;
  const subscriptionsRepository =
    options.kickSubscriptionsRepository || kickSubscriptionsRepository;
  const manualGrantService =
    options.manualSubGrantService || manualSubGrantService;

  function getEligibility(discordId, nowMs) {
    const targetDiscordId = normalizeDiscordId(discordId);
    const referenceNow = normalizeNowMs(nowMs, now);
    const broadcasterUserId = normalizeBroadcasterId(cfg.kickBroadcasterUserId);

    const linkedAccount = accountsRepository.findByDiscordId(targetDiscordId);

    const kickSource = {
      linked: Boolean(linkedAccount),
      active: false,
      observed: false,
      kickUserId: linkedAccount ? linkedAccount.kick_user_id : null,
      kickUsername: linkedAccount ? linkedAccount.kick_username : null,
      startedAtMs: null,
      expiresAtMs: null,
      subscriptionType: null,
    };

    if (linkedAccount && broadcasterUserId) {
      const observed = subscriptionsRepository.findByBroadcasterAndKickUser(
        broadcasterUserId,
        linkedAccount.kick_user_id,
      );

      if (observed) {
        kickSource.observed = true;
        kickSource.startedAtMs = observed.started_at_ms;
        kickSource.expiresAtMs = observed.expires_at_ms;
        kickSource.subscriptionType = observed.subscription_type;
        kickSource.active = observed.expires_at_ms > referenceNow;
      }
    }

    const manualActive = manualGrantService.hasActiveGrant(targetDiscordId, referenceNow);
    const manualStatus = manualGrantService.getStatus(targetDiscordId, referenceNow);
    const manualSource = mapManualSource(manualStatus);

    if (!manualActive) {
      manualSource.active = false;
      manualSource.reason = null;
      manualSource.grantedByDiscordId = null;
      manualSource.grantedAtMs = null;
      manualSource.expiresAtMs = null;
    }

    const eligible = kickSource.active || manualSource.active;

    return {
      discordId: targetDiscordId,
      eligible,
      sources: {
        kick: kickSource,
        manual: manualSource,
      },
    };
  }

  return {
    getEligibility,
  };
}

const defaultService = createSubscriberEligibilityService();
defaultService.createSubscriberEligibilityService = createSubscriberEligibilityService;

module.exports = defaultService;
