const subscriberEligibilityService = require('./subscriberEligibilityService');
const subscriberRoleService = require('./subscriberRoleService');
const subscriberRoleSyncAuditRepository = require('../database/subscriberRoleSyncAuditRepository');

function createSubscriberRoleSyncService(options = {}) {
  const eligibilityService = options.subscriberEligibilityService || subscriberEligibilityService;
  const roleService = options.subscriberRoleService || subscriberRoleService;
  const auditRepository =
    options.subscriberRoleSyncAuditRepository || subscriberRoleSyncAuditRepository;
  const now = options.now || (() => Date.now());

  async function syncUser(discordId, context = {}) {
    const targetDiscordId = typeof discordId === 'string' ? discordId.trim() : '';

    if (!targetDiscordId) {
      return {
        eligibility: null,
        sources: { kick: false, manual: false },
        action: 'not_altered',
        result: 'invalid_discord_id',
        auditSaved: false,
      };
    }

    const triggeredByDiscordId =
      typeof context.triggeredByDiscordId === 'string' && context.triggeredByDiscordId.trim()
        ? context.triggeredByDiscordId.trim()
        : 'system';
    const triggerType =
      typeof context.triggerType === 'string' && context.triggerType.trim()
        ? context.triggerType.trim()
        : 'manual';
    const reason =
      typeof context.reason === 'string' && context.reason.trim()
        ? context.reason.trim()
        : 'Sem motivo informado';

    const response = {
      eligibility: null,
      sources: { kick: false, manual: false },
      action: 'not_altered',
      result: 'eligibility_unavailable',
      auditSaved: false,
      roleName: null,
    };

    let eligibility;
    try {
      eligibility = eligibilityService.getEligibility(targetDiscordId, now());
    } catch (_error) {
      response.result = 'eligibility_error';
      return response;
    }

    const hasReliableEligibility =
      eligibility &&
      typeof eligibility.eligible === 'boolean' &&
      eligibility.sources &&
      eligibility.sources.kick &&
      eligibility.sources.manual;

    if (!hasReliableEligibility) {
      response.result = 'eligibility_unavailable';
      return response;
    }

    const kickActive = Boolean(eligibility.sources.kick.active);
    const manualActive = Boolean(eligibility.sources.manual.active);

    response.eligibility = eligibility.eligible;
    response.sources = {
      kick: kickActive,
      manual: manualActive,
    };

    const shouldHaveRole = eligibility.eligible;

    const roleResult = await roleService.ensureRoleState(
      context.client,
      targetDiscordId,
      shouldHaveRole,
    );

    response.result = roleResult?.result || 'discord_api_error';
    response.roleName = roleResult?.roleName || null;

    if (response.result === 'role_added') {
      response.action = 'role_added';
    } else if (response.result === 'role_removed') {
      response.action = 'role_removed';
    } else if (response.result === 'already_present' || response.result === 'already_absent') {
      response.action = 'already_correct';
    } else {
      response.action = 'not_altered';
    }

    try {
      auditRepository.register({
        discordId: targetDiscordId,
        eligible: eligibility.eligible,
        kickActive,
        manualActive,
        action: response.action,
        result: response.result,
        triggeredByDiscordId,
        triggerType,
        reason,
        createdAtMs: now(),
      });
      response.auditSaved = true;
    } catch (_error) {
      response.auditSaved = false;
      response.auditWarning = 'audit_failed';
    }

    return response;
  }

  return {
    syncUser,
  };
}

const defaultService = createSubscriberRoleSyncService();
defaultService.createSubscriberRoleSyncService = createSubscriberRoleSyncService;

module.exports = defaultService;
