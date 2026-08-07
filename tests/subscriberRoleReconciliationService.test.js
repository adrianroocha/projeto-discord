process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'guild-1';

const {
  createSubscriberRoleReconciliationService,
} = require('../src/services/subscriberRoleReconciliationService');

describe('subscriberRoleReconciliationService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function createService(overrides = {}) {
    const kickAccountsRepository =
      overrides.kickAccountsRepository || {
        listDistinctDiscordIds: jest.fn(() => ['discord-kick-1', 'discord-shared']),
      };

    const manualSubGrantsRepository =
      overrides.manualSubGrantsRepository || {
        listDistinctDiscordIds: jest.fn(() => ['discord-manual-1', 'discord-shared']),
      };

    const subscriberRoleSyncService =
      overrides.subscriberRoleSyncService || {
        syncUser: jest.fn(async () => ({
          action: 'already_correct',
          result: 'already_present',
        })),
      };

    const subscriberRoleReconciliationRunsRepository =
      overrides.subscriberRoleReconciliationRunsRepository || {
        registerStarted: jest.fn(() => 1),
        registerFinished: jest.fn(),
      };

    const logger =
      overrides.logger || {
        info: jest.fn(),
        warn: jest.fn(),
      };

    const service = createSubscriberRoleReconciliationService({
      config: {
        guildId: 'guild-1',
        subscriberRoleId: 'role-sub',
      },
      kickAccountsRepository,
      manualSubGrantsRepository,
      subscriberRoleSyncService,
      subscriberRoleReconciliationRunsRepository,
      logger,
      now: () => 1000,
      discoveryTimeoutMs: overrides.discoveryTimeoutMs || 500,
      userSyncTimeoutMs: overrides.userSyncTimeoutMs || 500,
    });

    return {
      service,
      kickAccountsRepository,
      manualSubGrantsRepository,
      subscriberRoleSyncService,
      subscriberRoleReconciliationRunsRepository,
      logger,
    };
  }

  function createClientWithSubRoleMembers(memberIds = []) {
    const membersMap = new Map(memberIds.map((id) => [id, { id }]));
    return {
      guilds: {
        fetch: jest.fn(async () => ({
          members: {
            fetch: jest.fn(async () => ({})),
          },
          roles: {
            fetch: jest.fn(async () => ({
              id: 'role-sub',
              members: membersMap,
            })),
          },
        })),
      },
    };
  }

  test('descobre candidatos com deduplicação entre banco e cargo atual', async () => {
    const { service, subscriberRoleSyncService } = createService();
    const client = createClientWithSubRoleMembers(['discord-role-1', 'discord-shared']);

    const result = await service.reconcileAll({
      client,
      triggerType: 'command_sub_reconcile',
      reason: 'Teste dedupe',
      triggeredByDiscordId: 'admin-1',
    });

    expect(result.totalCandidates).toBe(4);
    const calledIds = subscriberRoleSyncService.syncUser.mock.calls.map((call) => call[0]).sort();
    expect(calledIds).toEqual([
      'discord-kick-1',
      'discord-manual-1',
      'discord-role-1',
      'discord-shared',
    ]);
    expect(result.memberRoleDiscoveryComplete).toBe(true);
  });

  test('listagem de membros rejeitada marca descoberta incompleta', async () => {
    const { service, subscriberRoleSyncService } = createService({
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({
          action: 'not_altered',
          result: 'removal_blocked_discovery_incomplete',
        })),
      },
    });

    const client = {
      guilds: {
        fetch: jest.fn(async () => {
          throw new Error('discord error');
        }),
      },
    };

    const result = await service.reconcileAll({ client });
    expect(result.memberRoleDiscoveryComplete).toBe(false);
    expect(result.warnings).toContain('discord_role_members_unavailable');
    expect(subscriberRoleSyncService.syncUser).toHaveBeenCalled();
  });

  test('listagem de membros com timeout não pendura e marca descoberta incompleta', async () => {
    jest.useFakeTimers();

    const { service } = createService({
      discoveryTimeoutMs: 50,
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({
          action: 'not_altered',
          result: 'removal_blocked_discovery_incomplete',
        })),
      },
    });

    const never = new Promise(() => {});
    const client = {
      guilds: {
        fetch: jest.fn(async () => ({
          members: { fetch: jest.fn(() => never) },
          roles: { fetch: jest.fn(async () => ({ id: 'role-sub', members: new Map() })) },
        })),
      },
    };

    const promise = service.reconcileAll({ client });
    await jest.advanceTimersByTimeAsync(60);
    const result = await promise;

    expect(result.memberRoleDiscoveryComplete).toBe(false);
    expect(result.warnings).toContain('discord_role_members_unavailable');
  });

  test('contabiliza role_added, role_removed, already_correct e skipped', async () => {
    const syncUser = jest
      .fn()
      .mockResolvedValueOnce({ action: 'role_added', result: 'role_added' })
      .mockResolvedValueOnce({ action: 'role_removed', result: 'role_removed' })
      .mockResolvedValueOnce({ action: 'already_correct', result: 'already_present' })
      .mockResolvedValueOnce({ action: 'not_altered', result: 'eligibility_error' });

    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['a', 'b']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => ['c']) },
      subscriberRoleSyncService: { syncUser },
    });

    const client = createClientWithSubRoleMembers(['d']);
    const result = await service.reconcileAll({ client, triggerType: 'scheduler_sub_reconcile' });

    expect(result.processed).toBe(4);
    expect(result.roleAdded).toBe(1);
    expect(result.roleRemoved).toBe(1);
    expect(result.alreadyCorrect).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  test('erro de discord em um usuário não interrompe os demais', async () => {
    const syncUser = jest
      .fn()
      .mockRejectedValueOnce(new Error('discord down'))
      .mockResolvedValueOnce({ action: 'already_correct', result: 'already_present' });

    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u1']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => ['u2']) },
      subscriberRoleSyncService: { syncUser },
    });

    const client = createClientWithSubRoleMembers([]);
    const result = await service.reconcileAll({ client, triggerType: 'scheduler_sub_reconcile' });

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.alreadyCorrect).toBe(1);
  });

  test('membro inexistente é ignorado de forma controlada', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u1']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({
          action: 'not_altered',
          result: 'member_not_found',
        })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.status).toBe('completed');
    expect(result.skippedByCode.member_not_found).toBe(1);
  });

  test('execução somente com member_not_found não termina como completed_with_failures', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['m1', 'm2']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'not_altered', result: 'member_not_found' })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(result.status).toBe('completed');
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.skippedByCode.member_not_found).toBe(2);
  });

  test('trava impede execução concorrente', async () => {
    let resolveSync;
    const pendingSync = new Promise((resolve) => {
      resolveSync = resolve;
    });
    const syncUser = jest.fn(() => pendingSync);

    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u1']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: { syncUser },
    });

    const firstPromise = service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    await Promise.resolve();
    const second = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });

    expect(second.status).toBe('already_running');

    resolveSync({ action: 'already_correct', result: 'already_present' });
    await firstPromise;

    const third = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(third.status).not.toBe('already_running');
  });

  test('trava é liberada quando descoberta falha', async () => {
    const { service } = createService({
      kickAccountsRepository: {
        listDistinctDiscordIds: jest.fn(() => {
          throw new Error('db down');
        }),
      },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
    });

    const first = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(first.status).toBe('failed');

    const second = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(second.status).not.toBe('already_running');
  });

  test('trava é liberada quando auditoria falha', async () => {
    const runsRepository = {
      registerStarted: jest.fn(() => {
        throw new Error('audit start down');
      }),
      registerFinished: jest.fn(),
    };

    const { service } = createService({
      subscriberRoleReconciliationRunsRepository: runsRepository,
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u1']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
    });

    await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    const second = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(second.status).not.toBe('already_running');
  });

  test('trava é liberada quando sync por usuário estoura timeout', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u1']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      userSyncTimeoutMs: 10,
      subscriberRoleSyncService: {
        syncUser: jest.fn(() => new Promise(() => {})),
      },
    });

    const first = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(first.failed).toBe(1);

    const second = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(second.status).not.toBe('already_running');
  }, 10_000);

  test('audita execução no repositório de runs', async () => {
    const runsRepository = {
      registerStarted: jest.fn(() => 42),
      registerFinished: jest.fn(),
    };

    const { service } = createService({
      subscriberRoleReconciliationRunsRepository: runsRepository,
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u1']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'already_correct', result: 'already_present' })),
      },
    });

    await service.reconcileAll({
      client: createClientWithSubRoleMembers([]),
      triggerType: 'command_sub_reconcile',
      triggeredByDiscordId: 'admin-1',
      reason: 'Auditoria',
    });

    expect(runsRepository.registerStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: 'command_sub_reconcile',
        triggeredByDiscordId: 'admin-1',
        reason: 'Auditoria',
      }),
    );
    expect(runsRepository.registerFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        totalCandidates: 1,
      }),
    );
  });

  test('falha de elegibilidade não remove cargo e vira skipped', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u1']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'not_altered', result: 'eligibility_unavailable' })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(result.roleRemoved).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('falha real mantém status completed_with_failures', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u1']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'not_altered', result: 'member_not_manageable' })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(result.status).toBe('completed_with_failures');
    expect(result.failed).toBe(1);
    expect(result.failedByCode.member_not_manageable).toBe(1);
  });

  test('concessão manual vencida sem Kick ativa pode remover SUB', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-expired-manual']) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'role_removed', result: 'role_removed' })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(result.roleRemoved).toBe(1);
  });

  test('assinatura Kick vencida sem manual ativa pode remover SUB', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-expired-kick']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'role_removed', result: 'role_removed' })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(result.roleRemoved).toBe(1);
  });

  test('manual ativa mantém SUB mesmo com Kick expirada', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-manual-active']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-manual-active']) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'already_correct', result: 'already_present' })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(result.alreadyCorrect).toBe(1);
    expect(result.roleRemoved).toBe(0);
  });

  test('Kick ativa mantém SUB mesmo com manual expirada', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-kick-active']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-kick-active']) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'already_correct', result: 'already_present' })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(result.alreadyCorrect).toBe(1);
    expect(result.roleRemoved).toBe(0);
  });

  test('usuário elegível sem cargo recebe adição', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-eligible-no-role']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'role_added', result: 'role_added' })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(result.roleAdded).toBe(1);
  });

  test('usuário com cargo órfão entra por descoberta de role e pode ser removido', async () => {
    const { service, subscriberRoleSyncService } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'role_removed', result: 'role_removed' })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers(['u-orphan-role']) });

    expect(subscriberRoleSyncService.syncUser).toHaveBeenCalledWith(
      'u-orphan-role',
      expect.any(Object),
    );
    expect(result.roleRemoved).toBe(1);
  });

  test('descoberta incompleta não remove cargos', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-ineligible']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async (_discordId, context) => {
          if (context.allowRoleRemoval === false) {
            return {
              action: 'not_altered',
              result: 'removal_blocked_discovery_incomplete',
            };
          }

          return { action: 'role_removed', result: 'role_removed' };
        }),
      },
    });

    const brokenClient = {
      guilds: {
        fetch: jest.fn(async () => {
          throw new Error('guild down');
        }),
      },
    };

    const result = await service.reconcileAll({ client: brokenClient });
    expect(result.memberRoleDiscoveryComplete).toBe(false);
    expect(result.roleRemoved).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('descoberta incompleta ainda permite adição para elegível conhecido', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-eligible']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'role_added', result: 'role_added' })),
      },
    });

    const brokenClient = {
      guilds: {
        fetch: jest.fn(async () => {
          throw new Error('guild down');
        }),
      },
    };

    const result = await service.reconcileAll({ client: brokenClient });
    expect(result.memberRoleDiscoveryComplete).toBe(false);
    expect(result.roleAdded).toBe(1);
  });

  test('busca completa de membros ocorre no máximo uma vez por execução', async () => {
    const membersFetch = jest.fn(async () => ({}));
    const rolesFetch = jest.fn(async () => ({ id: 'role-sub', members: new Map() }));
    const client = {
      guilds: {
        fetch: jest.fn(async () => ({
          members: { fetch: membersFetch },
          roles: { fetch: rolesFetch },
        })),
      },
    };

    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u1', 'u2']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => ['u3']) },
    });

    await service.reconcileAll({ client });

    expect(client.guilds.fetch).toHaveBeenCalledTimes(1);
    expect(membersFetch).toHaveBeenCalledTimes(1);
    expect(rolesFetch).toHaveBeenCalledTimes(1);
  });

  test('contabiliza falha de auditoria separadamente', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-audit']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({
          action: 'already_correct',
          result: 'already_present',
          auditWarning: 'audit_failed',
        })),
      },
    });

    const result = await service.reconcileAll({ client: createClientWithSubRoleMembers([]) });
    expect(result.failed).toBe(0);
    expect(result.auditWarnings.audit_failed).toBe(1);
  });

  test('guild ou cargo indisponível registra falha segura e segue banco', async () => {
    const { service } = createService({
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u-db']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: {
        syncUser: jest.fn(async () => ({ action: 'not_altered', result: 'role_not_found' })),
      },
    });

    const brokenClient = {
      guilds: {
        fetch: jest.fn(async () => {
          throw new Error('guild down');
        }),
      },
    };

    const result = await service.reconcileAll({ client: brokenClient });
    expect(result.failed).toBe(1);
    expect(result.warnings).toContain('discord_role_members_unavailable');
  });
});
