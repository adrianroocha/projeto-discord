const config = require('../config');
const kickAccountsRepository = require('../database/kickAccountsRepository');
const manualSubGrantsRepository = require('../database/manualSubGrantsRepository');
const subscriberRoleSyncService = require('./subscriberRoleSyncService');
const reconciliationRunsRepository = require('../database/subscriberRoleReconciliationRunsRepository');

const DEFAULT_DISCOVERY_TIMEOUT_MS = 20_000;
const DEFAULT_USER_SYNC_TIMEOUT_MS = 12_000;

function normalizeNowMs(nowMs, nowFn) {
  if (nowMs !== undefined && nowMs !== null) {
    const parsed = Number(nowMs);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return Math.trunc(nowFn());
}

function toSafeReason(reason) {
  if (typeof reason !== 'string') {
    return 'Reconciliação automática';
  }

  const normalized = reason.trim();
  if (!normalized) {
    return 'Reconciliação automática';
  }

  return normalized.slice(0, 280);
}

function toSafeTriggeredByDiscordId(triggeredByDiscordId) {
  if (typeof triggeredByDiscordId !== 'string') {
    return null;
  }

  const normalized = triggeredByDiscordId.trim();
  return normalized || null;
}

function normalizeTriggerType(triggerType) {
  if (typeof triggerType !== 'string') {
    return 'sub_role_reconciliation';
  }

  const normalized = triggerType.trim();
  return normalized || 'sub_role_reconciliation';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function createTimeoutError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function withTimeout(promise, timeoutMs, timeoutCode) {
  const safeTimeoutMs = Math.max(1, Number(timeoutMs) || 1);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createTimeoutError(timeoutCode));
    }, safeTimeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function classifySyncResult(syncResult) {
  if (!syncResult || typeof syncResult !== 'object') {
    return { bucket: 'failed', code: 'unknown_result' };
  }

  const action = syncResult.action;
  const resultCode = typeof syncResult.result === 'string' ? syncResult.result : 'unknown_result';

  if (action === 'role_added') {
    return { bucket: 'roleAdded', code: resultCode };
  }

  if (action === 'role_removed') {
    return { bucket: 'roleRemoved', code: resultCode };
  }

  if (action === 'already_correct') {
    return { bucket: 'alreadyCorrect', code: resultCode };
  }

  if (
    resultCode === 'eligibility_unavailable' ||
    resultCode === 'eligibility_error' ||
    resultCode === 'invalid_discord_id' ||
    resultCode === 'member_not_found' ||
    resultCode === 'removal_blocked_discovery_incomplete'
  ) {
    return { bucket: 'skipped', code: resultCode };
  }

  return { bucket: 'failed', code: resultCode };
}

async function listDiscordIdsWithSubscriberRole(client, cfg, logger, timeoutMs) {
  if (!cfg.subscriberRoleId || !cfg.subscriberRoleId.trim()) {
    return { ids: [], warnings: ['subscriber_role_not_configured'], complete: false };
  }

  if (!cfg.guildId || !cfg.guildId.trim()) {
    return { ids: [], warnings: ['guild_not_configured'], complete: false };
  }

  if (!client || !client.guilds || typeof client.guilds.fetch !== 'function') {
    return { ids: [], warnings: ['discord_client_unavailable'], complete: false };
  }

  try {
    const guild = await withTimeout(
      client.guilds.fetch(cfg.guildId),
      timeoutMs,
      'discord_guild_fetch_timeout',
    );
    if (!guild) {
      return { ids: [], warnings: ['guild_not_found'], complete: false };
    }

    await withTimeout(guild.members.fetch(), timeoutMs, 'discord_members_fetch_timeout');

    const roleId = cfg.subscriberRoleId.trim();
    const role = await withTimeout(guild.roles.fetch(roleId), timeoutMs, 'discord_role_fetch_timeout');
    if (!role) {
      return { ids: [], warnings: ['role_not_found'], complete: false };
    }

    const ids = [];
    for (const member of role.members.values()) {
      if (isNonEmptyString(member?.id)) {
        ids.push(member.id.trim());
      }
    }

    return { ids, warnings: [], complete: true };
  } catch {
    if (typeof logger?.warn === 'function') {
      logger.warn('Reconciliação SUB: falha ao listar membros com cargo SUB.');
    }
    return { ids: [], warnings: ['discord_role_members_unavailable'], complete: false };
  }
}

function createSubscriberRoleReconciliationService(options = {}) {
  let runningPromise = null;

  const cfg = options.config || config;
  const logger = options.logger || console;
  const now = options.now || (() => Date.now());
  const accountsRepository = options.kickAccountsRepository || kickAccountsRepository;
  const grantsRepository = options.manualSubGrantsRepository || manualSubGrantsRepository;
  const syncService = options.subscriberRoleSyncService || subscriberRoleSyncService;
  const runsRepository =
    options.subscriberRoleReconciliationRunsRepository || reconciliationRunsRepository;
  const discoveryTimeoutMs =
    Number(options.discoveryTimeoutMs || cfg.subRoleReconciliationDiscoveryTimeoutMs) ||
    DEFAULT_DISCOVERY_TIMEOUT_MS;
  const userSyncTimeoutMs =
    Number(options.userSyncTimeoutMs || cfg.subRoleReconciliationUserSyncTimeoutMs) ||
    DEFAULT_USER_SYNC_TIMEOUT_MS;

  function incrementCodeCounter(targetMap, code) {
    const key = isNonEmptyString(code) ? code.trim() : 'unknown_code';
    targetMap[key] = (targetMap[key] || 0) + 1;
  }

  async function buildCandidates(client) {
    const candidateSet = new Set();

    const kickIds = accountsRepository.listDistinctDiscordIds();
    for (const discordId of kickIds) {
      if (isNonEmptyString(discordId)) {
        candidateSet.add(discordId.trim());
      }
    }

    const manualIds = grantsRepository.listDistinctDiscordIds();
    for (const discordId of manualIds) {
      if (isNonEmptyString(discordId)) {
        candidateSet.add(discordId.trim());
      }
    }

    const roleMembers = await listDiscordIdsWithSubscriberRole(
      client,
      cfg,
      logger,
      discoveryTimeoutMs,
    );
    for (const discordId of roleMembers.ids) {
      if (isNonEmptyString(discordId)) {
        candidateSet.add(discordId.trim());
      }
    }

    return {
      ids: [...candidateSet],
      warnings: roleMembers.warnings,
      memberRoleDiscoveryComplete: roleMembers.complete,
    };
  }

  async function reconcileAll(input = {}) {
    if (runningPromise) {
      return {
        status: 'already_running',
        totalCandidates: 0,
        processed: 0,
        roleAdded: 0,
        roleRemoved: 0,
        alreadyCorrect: 0,
        skipped: 0,
        failed: 0,
        failures: [],
        warnings: [],
        memberRoleDiscoveryComplete: false,
        skippedByCode: {},
        failedByCode: {},
        auditWarnings: {},
      };
    }

    const startedAtMs = normalizeNowMs(input.nowMs, now);
    const reason = toSafeReason(input.reason);
    const triggerType = normalizeTriggerType(input.triggerType);
    const triggeredByDiscordId = toSafeTriggeredByDiscordId(input.triggeredByDiscordId);

    const task = (async () => {
      const summary = {
        status: 'completed',
        totalCandidates: 0,
        processed: 0,
        roleAdded: 0,
        roleRemoved: 0,
        alreadyCorrect: 0,
        skipped: 0,
        failed: 0,
        failures: [],
        warnings: [],
        memberRoleDiscoveryComplete: true,
        skippedByCode: {},
        failedByCode: {},
        auditWarnings: {},
      };

      let runId = null;
      try {
        runId = runsRepository.registerStarted({
          triggerType,
          triggeredByDiscordId,
          reason,
          startedAtMs,
        });
      } catch {
        summary.warnings.push('reconciliation_run_audit_unavailable');
      }

      try {
        const candidates = await buildCandidates(input.client);
        summary.totalCandidates = candidates.ids.length;
        summary.warnings.push(...candidates.warnings);
        summary.memberRoleDiscoveryComplete = Boolean(candidates.memberRoleDiscoveryComplete);

        for (const discordId of candidates.ids) {
          try {
            const syncResult = await withTimeout(
              syncService.syncUser(discordId, {
                client: input.client,
                triggerType,
                triggeredByDiscordId: triggeredByDiscordId || 'system',
                reason,
                allowRoleRemoval: summary.memberRoleDiscoveryComplete,
              }),
              userSyncTimeoutMs,
              'discord_sync_timeout',
            );

            summary.processed += 1;
            const classification = classifySyncResult(syncResult);

            if (classification.bucket === 'roleAdded') {
              summary.roleAdded += 1;
            } else if (classification.bucket === 'roleRemoved') {
              summary.roleRemoved += 1;
            } else if (classification.bucket === 'alreadyCorrect') {
              summary.alreadyCorrect += 1;
            } else if (classification.bucket === 'skipped') {
              summary.skipped += 1;
              incrementCodeCounter(summary.skippedByCode, classification.code);
            } else {
              summary.failed += 1;
              incrementCodeCounter(summary.failedByCode, classification.code);
              summary.failures.push({
                discordId,
                code: classification.code,
              });
              if (typeof logger?.warn === 'function') {
                logger.warn(
                  `Reconciliação SUB: falha individual segura code=${classification.code} trigger=${triggerType}`,
                );
              }
            }

            if (syncResult?.auditWarning) {
              incrementCodeCounter(summary.auditWarnings, syncResult.auditWarning);
            }
          } catch (_error) {
            summary.processed += 1;
            summary.failed += 1;
            incrementCodeCounter(summary.failedByCode, _error?.code || 'unexpected_error');
            summary.failures.push({
              discordId,
              code: _error?.code || 'unexpected_error',
            });
            if (typeof logger?.warn === 'function') {
              logger.warn(
                `Reconciliação SUB: falha individual segura code=${_error?.code || 'unexpected_error'} trigger=${triggerType}`,
              );
            }
          }
        }

        if (!summary.memberRoleDiscoveryComplete) {
          summary.warnings.push('member_role_discovery_incomplete_removals_blocked');
        }

        if (summary.failed > 0) {
          summary.status = 'completed_with_failures';
        }
      } catch {
        summary.status = 'failed';
        summary.failed += 1;
        summary.failures.push({
          discordId: null,
          code: 'reconciliation_unavailable',
        });
      } finally {
        const finishedAtMs = normalizeNowMs(input.nowMs, now);
        if (runId !== null) {
          try {
            runsRepository.registerFinished({
              id: runId,
              finishedAtMs,
              totalCandidates: summary.totalCandidates,
              processed: summary.processed,
              roleAdded: summary.roleAdded,
              roleRemoved: summary.roleRemoved,
              alreadyCorrect: summary.alreadyCorrect,
              skipped: summary.skipped,
              failed: summary.failed,
              status: summary.status,
            });
          } catch {
            summary.warnings.push('reconciliation_run_audit_finalize_unavailable');
          }
        }
      }

      if (typeof logger?.info === 'function') {
        logger.info(
          `Reconciliação SUB: status=${summary.status} candidatos=${summary.totalCandidates} processados=${summary.processed} add=${summary.roleAdded} remove=${summary.roleRemoved} corretos=${summary.alreadyCorrect} ignorados=${summary.skipped} falhas=${summary.failed} skipped_codes=${JSON.stringify(summary.skippedByCode)} failed_codes=${JSON.stringify(summary.failedByCode)} audit_warnings=${JSON.stringify(summary.auditWarnings)} descoberta_completa=${summary.memberRoleDiscoveryComplete ? 'sim' : 'nao'}`,
        );
      }

      return summary;
    })();

    runningPromise = task;
    try {
      return await task;
    } finally {
      runningPromise = null;
    }
  }

  function isRunning() {
    return Boolean(runningPromise);
  }

  return {
    reconcileAll,
    isRunning,
    _private: {
      buildCandidates,
      classifySyncResult,
      listDiscordIdsWithSubscriberRole,
    },
  };
}

const defaultService = createSubscriberRoleReconciliationService();
defaultService.createSubscriberRoleReconciliationService = createSubscriberRoleReconciliationService;

module.exports = defaultService;
