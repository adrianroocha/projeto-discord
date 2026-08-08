process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'guild-1';

const {
  createSubscriberRoleReconciliationScheduler,
} = require('../src/services/subscriberRoleReconciliationScheduler');
const {
  createSubscriberRoleReconciliationService,
} = require('../src/services/subscriberRoleReconciliationService');
const lifecycleService = require('../src/services/applicationLifecycleService');

describe('subscriberRoleReconciliationScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    lifecycleService._resetForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
    lifecycleService._resetForTests();
  });

  test('não inicia enquanto aplicação está em shutdown', () => {
    lifecycleService.beginShutdown('SIGTERM');

    const scheduler = createSubscriberRoleReconciliationScheduler({
      config: {
        nodeEnv: 'production',
        subRoleReconciliationEnabled: true,
        subRoleReconciliationIntervalMinutes: 1,
        subRoleReconciliationStartupDelaySeconds: 1,
      },
      subscriberRoleReconciliationService: {
        reconcileAll: jest.fn(),
        isRunning: jest.fn(() => false),
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    const startResult = scheduler.start({});
    expect(startResult).toEqual({ started: false, reason: 'shutting_down' });
  });

  test('não inicia em ambiente de teste (sem timers ativos)', () => {
    const scheduler = createSubscriberRoleReconciliationScheduler({
      config: {
        nodeEnv: 'test',
        subRoleReconciliationEnabled: true,
        subRoleReconciliationIntervalMinutes: 15,
        subRoleReconciliationStartupDelaySeconds: 30,
      },
      subscriberRoleReconciliationService: {
        reconcileAll: jest.fn(),
        isRunning: jest.fn(() => false),
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    const startResult = scheduler.start({});
    expect(startResult).toEqual({ started: false, reason: 'disabled_test_env' });
  });

  test('não inicia quando desabilitado em config', () => {
    const reconcileAll = jest.fn();
    const scheduler = createSubscriberRoleReconciliationScheduler({
      config: {
        nodeEnv: 'production',
        subRoleReconciliationEnabled: false,
        subRoleReconciliationIntervalMinutes: 15,
        subRoleReconciliationStartupDelaySeconds: 30,
      },
      subscriberRoleReconciliationService: {
        reconcileAll,
        isRunning: jest.fn(() => false),
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    const startResult = scheduler.start({});
    expect(startResult.reason).toBe('disabled_config');
    expect(reconcileAll).not.toHaveBeenCalled();
  });

  test('respeita delay inicial e intervalo', async () => {
    const reconcileAll = jest.fn().mockResolvedValue({ status: 'completed' });
    const scheduler = createSubscriberRoleReconciliationScheduler({
      config: {
        nodeEnv: 'production',
        subRoleReconciliationEnabled: true,
        subRoleReconciliationIntervalMinutes: 2,
        subRoleReconciliationStartupDelaySeconds: 10,
      },
      subscriberRoleReconciliationService: {
        reconcileAll,
        isRunning: jest.fn(() => false),
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    scheduler.start({ id: 'client-1' });

    await jest.advanceTimersByTimeAsync(9_000);
    expect(reconcileAll).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(reconcileAll).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(120_000);
    expect(reconcileAll).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  test('não sobrepõe execução e agenda próxima somente após término', async () => {
    let resolveFirst;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const reconcileAll = jest
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolvedValue({ status: 'completed' });

    const scheduler = createSubscriberRoleReconciliationScheduler({
      config: {
        nodeEnv: 'production',
        subRoleReconciliationEnabled: true,
        subRoleReconciliationIntervalMinutes: 1,
        subRoleReconciliationStartupDelaySeconds: 1,
      },
      subscriberRoleReconciliationService: {
        reconcileAll,
        isRunning: jest.fn(() => false),
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    scheduler.start({});
    await jest.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(reconcileAll).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(120_000);
    expect(reconcileAll).toHaveBeenCalledTimes(1);

    resolveFirst({ status: 'completed' });
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(60_000);
    expect(reconcileAll).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  test('execução manual é bloqueada enquanto scheduler mantém trava ativa e libera depois', async () => {
    let releaseSync;
    const pendingSync = new Promise((resolve) => {
      releaseSync = resolve;
    });

    const reconciliationService = createSubscriberRoleReconciliationService({
      config: { guildId: 'guild-1', subscriberRoleId: null },
      kickAccountsRepository: { listDistinctDiscordIds: jest.fn(() => ['u1']) },
      manualSubGrantsRepository: { listDistinctDiscordIds: jest.fn(() => []) },
      subscriberRoleSyncService: { syncUser: jest.fn(() => pendingSync) },
      subscriberRoleReconciliationRunsRepository: {
        registerStarted: jest.fn(() => 1),
        registerFinished: jest.fn(),
      },
      logger: { info: jest.fn(), warn: jest.fn() },
      userSyncTimeoutMs: 10_000,
    });

    const scheduler = createSubscriberRoleReconciliationScheduler({
      config: {
        nodeEnv: 'production',
        subRoleReconciliationEnabled: true,
        subRoleReconciliationIntervalMinutes: 1,
        subRoleReconciliationStartupDelaySeconds: 1,
      },
      subscriberRoleReconciliationService: reconciliationService,
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    scheduler.start({});
    await jest.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    const blocked = await reconciliationService.reconcileAll({
      client: {},
      triggerType: 'command_sub_reconcile',
      reason: 'manual',
      triggeredByDiscordId: 'admin-1',
    });
    expect(blocked.status).toBe('already_running');

    releaseSync({ action: 'already_correct', result: 'already_present' });
  await Promise.resolve();
  await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);

    const after = await reconciliationService.reconcileAll({
      client: {},
      triggerType: 'command_sub_reconcile',
      reason: 'manual-2',
      triggeredByDiscordId: 'admin-1',
    });
    expect(after.status).not.toBe('already_running');

    scheduler.stop();
  });

  test('stop remove timers ativos', async () => {
    const reconcileAll = jest.fn().mockResolvedValue({ status: 'completed' });
    const scheduler = createSubscriberRoleReconciliationScheduler({
      config: {
        nodeEnv: 'production',
        subRoleReconciliationEnabled: true,
        subRoleReconciliationIntervalMinutes: 1,
        subRoleReconciliationStartupDelaySeconds: 1,
      },
      subscriberRoleReconciliationService: {
        reconcileAll,
        isRunning: jest.fn(() => false),
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    });

    scheduler.start({});
    scheduler.stop();

    await jest.advanceTimersByTimeAsync(120_000);
    expect(reconcileAll).not.toHaveBeenCalled();
  });
});
