process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'guild-1';

const { createSubscriberRoleSyncService } = require('../src/services/subscriberRoleSyncService');

describe('subscriberRoleSyncService', () => {
  function createService(overrides = {}) {
    const eligibilityService =
      overrides.subscriberEligibilityService || {
        getEligibility: jest.fn(() => ({
          eligible: true,
          sources: {
            kick: { active: false },
            manual: { active: true },
          },
        })),
      };

    const roleService =
      overrides.subscriberRoleService || {
        ensureRoleState: jest.fn(async () => ({ result: 'role_added', roleName: 'sub' })),
      };

    const auditRepository =
      overrides.subscriberRoleSyncAuditRepository || {
        register: jest.fn(),
      };

    const service = createSubscriberRoleSyncService({
      subscriberEligibilityService: eligibilityService,
      subscriberRoleService: roleService,
      subscriberRoleSyncAuditRepository: auditRepository,
      now: () => 1000,
    });

    return { service, eligibilityService, roleService, auditRepository };
  }

  test('adiciona cargo para elegibilidade manual ativa', async () => {
    const { service, roleService } = createService({
      subscriberEligibilityService: {
        getEligibility: jest.fn(() => ({
          eligible: true,
          sources: { kick: { active: false }, manual: { active: true } },
        })),
      },
    });

    const result = await service.syncUser('user-1', { client: {} });

    expect(roleService.ensureRoleState).toHaveBeenCalledWith({}, 'user-1', true);
    expect(result.action).toBe('role_added');
  });

  test('adiciona cargo para elegibilidade Kick ativa', async () => {
    const { service, roleService } = createService({
      subscriberEligibilityService: {
        getEligibility: jest.fn(() => ({
          eligible: true,
          sources: { kick: { active: true }, manual: { active: false } },
        })),
      },
    });

    const result = await service.syncUser('user-2', { client: {} });

    expect(roleService.ensureRoleState).toHaveBeenCalledWith({}, 'user-2', true);
    expect(result.sources.kick).toBe(true);
    expect(result.sources.manual).toBe(false);
  });

  test('mantém correto com ambas as fontes', async () => {
    const { service } = createService({
      subscriberEligibilityService: {
        getEligibility: jest.fn(() => ({
          eligible: true,
          sources: { kick: { active: true }, manual: { active: true } },
        })),
      },
      subscriberRoleService: {
        ensureRoleState: jest.fn(async () => ({ result: 'already_present', roleName: 'sub' })),
      },
    });

    const result = await service.syncUser('user-3', { client: {} });

    expect(result.action).toBe('already_correct');
    expect(result.result).toBe('already_present');
  });

  test('remove cargo sem fontes ativas', async () => {
    const { service, roleService } = createService({
      subscriberEligibilityService: {
        getEligibility: jest.fn(() => ({
          eligible: false,
          sources: { kick: { active: false }, manual: { active: false } },
        })),
      },
      subscriberRoleService: {
        ensureRoleState: jest.fn(async () => ({ result: 'role_removed', roleName: 'sub' })),
      },
    });

    const result = await service.syncUser('user-4', { client: {} });

    expect(roleService.ensureRoleState).toHaveBeenCalledWith({}, 'user-4', false);
    expect(result.action).toBe('role_removed');
  });

  test('falha de elegibilidade não remove cargo nem chama role service', async () => {
    const roleService = { ensureRoleState: jest.fn() };
    const { service } = createService({
      subscriberEligibilityService: {
        getEligibility: jest.fn(() => {
          throw new Error('db failure');
        }),
      },
      subscriberRoleService: roleService,
    });

    const result = await service.syncUser('user-5', { client: {} });

    expect(result.action).toBe('not_altered');
    expect(result.result).toBe('eligibility_error');
    expect(roleService.ensureRoleState).not.toHaveBeenCalled();
  });

  test('bloqueia remoção quando allowRoleRemoval é false', async () => {
    const roleService = { ensureRoleState: jest.fn() };
    const auditRepository = { register: jest.fn() };

    const { service } = createService({
      subscriberEligibilityService: {
        getEligibility: jest.fn(() => ({
          eligible: false,
          sources: { kick: { active: false }, manual: { active: false } },
        })),
      },
      subscriberRoleService: roleService,
      subscriberRoleSyncAuditRepository: auditRepository,
    });

    const result = await service.syncUser('user-no-remove', {
      client: {},
      allowRoleRemoval: false,
      triggerType: 'scheduler_sub_reconcile',
      reason: 'descoberta incompleta',
    });

    expect(result.result).toBe('removal_blocked_discovery_incomplete');
    expect(result.action).toBe('not_altered');
    expect(roleService.ensureRoleState).not.toHaveBeenCalled();
    expect(auditRepository.register).toHaveBeenCalled();
  });

  test('resultado already_absent vira já estava correto', async () => {
    const { service } = createService({
      subscriberEligibilityService: {
        getEligibility: jest.fn(() => ({
          eligible: false,
          sources: { kick: { active: false }, manual: { active: false } },
        })),
      },
      subscriberRoleService: {
        ensureRoleState: jest.fn(async () => ({ result: 'already_absent', roleName: 'sub' })),
      },
    });

    const result = await service.syncUser('user-6', { client: {} });

    expect(result.action).toBe('already_correct');
  });

  test('auditoria de adição', async () => {
    const auditRepository = { register: jest.fn() };
    const { service } = createService({ subscriberRoleSyncAuditRepository: auditRepository });

    const result = await service.syncUser('user-7', {
      client: {},
      triggeredByDiscordId: 'admin-1',
      triggerType: 'command_sub_sync',
      reason: 'Teste adição',
    });

    expect(result.auditSaved).toBe(true);
    expect(auditRepository.register).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'user-7',
        action: 'role_added',
        triggeredByDiscordId: 'admin-1',
      }),
    );
  });

  test('auditoria de remoção', async () => {
    const auditRepository = { register: jest.fn() };
    const { service } = createService({
      subscriberEligibilityService: {
        getEligibility: jest.fn(() => ({
          eligible: false,
          sources: { kick: { active: false }, manual: { active: false } },
        })),
      },
      subscriberRoleService: {
        ensureRoleState: jest.fn(async () => ({ result: 'role_removed', roleName: 'sub' })),
      },
      subscriberRoleSyncAuditRepository: auditRepository,
    });

    await service.syncUser('user-8', {
      client: {},
      triggeredByDiscordId: 'admin-2',
      triggerType: 'command_sub_sync',
      reason: 'Teste remoção',
    });

    expect(auditRepository.register).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'user-8',
        action: 'role_removed',
      }),
    );
  });

  test('auditoria de nenhuma alteração', async () => {
    const auditRepository = { register: jest.fn() };
    const { service } = createService({
      subscriberRoleService: {
        ensureRoleState: jest.fn(async () => ({ result: 'already_present', roleName: 'sub' })),
      },
      subscriberRoleSyncAuditRepository: auditRepository,
    });

    await service.syncUser('user-9', {
      client: {},
      triggeredByDiscordId: 'admin-3',
      triggerType: 'command_sub_sync',
      reason: 'Sem mudança',
    });

    expect(auditRepository.register).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'already_correct',
      }),
    );
  });

  test('falha da auditoria não desfaz alteração de cargo', async () => {
    const auditRepository = {
      register: jest.fn(() => {
        throw new Error('audit down');
      }),
    };

    const { service } = createService({ subscriberRoleSyncAuditRepository: auditRepository });
    const result = await service.syncUser('user-10', {
      client: {},
      triggeredByDiscordId: 'admin-4',
      triggerType: 'command_sub_sync',
      reason: 'Audit fail',
    });

    expect(result.action).toBe('role_added');
    expect(result.auditSaved).toBe(false);
    expect(result.auditWarning).toBe('audit_failed');
  });

  test('nenhuma chamada real à Kick', async () => {
    const originalFetch = global.fetch;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    try {
      const { service } = createService();
      await service.syncUser('user-11', { client: {} });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
