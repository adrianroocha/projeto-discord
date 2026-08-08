process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const { createSqliteBackupScheduler } = require('../src/services/sqliteBackupScheduler');

describe('sqliteBackupScheduler', () => {
  let state;
  let stateRepo;
  let backupService;
  let lifecycleService;
  let scheduler;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));

    state = {
      last_success_local_date: null,
      last_attempt_started_at_ms: null,
      last_result: null,
      updated_at_ms: Date.now(),
    };

    stateRepo = {
      getState: jest.fn(() => ({ ...state })),
      updateState: jest.fn((patch) => {
        if (Object.prototype.hasOwnProperty.call(patch, 'lastSuccessLocalDate')) {
          state.last_success_local_date = patch.lastSuccessLocalDate;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'lastAttemptStartedAtMs')) {
          state.last_attempt_started_at_ms = patch.lastAttemptStartedAtMs;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'lastResult')) {
          state.last_result = patch.lastResult;
        }
        state.updated_at_ms = Date.now();
        return { ...state };
      }),
    };

    backupService = {
      createBackup: jest.fn().mockResolvedValue({ success: true, result: 'ok' }),
      cleanupRetention: jest.fn(() => ({ removedCount: 0, scannedCount: 0 })),
      waitForOngoingBackup: jest.fn().mockResolvedValue({ waited: false, timeout: false }),
    };

    lifecycleService = {
      isShuttingDown: jest.fn(() => false),
    };
  });

  afterEach(() => {
    if (scheduler && typeof scheduler._resetForTests === 'function') {
      scheduler._resetForTests();
    }
    jest.useRealTimers();
  });

  function createScheduler(configOverrides = {}) {
    scheduler = createSqliteBackupScheduler({
      config: {
        nodeEnv: 'production',
        sqliteBackupEnabled: true,
        sqliteBackupTime: '08:15',
        sqliteBackupTimezone: 'America/Sao_Paulo',
        sqliteBackupRetentionDays: 7,
        sqliteBackupStartupDelaySeconds: 60,
        ...configOverrides,
      },
      sqliteBackupService: backupService,
      sqliteBackupSchedulerStateRepository: stateRepo,
      lifecycleService,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });

    return scheduler;
  }

  test('não inicia quando desabilitado', () => {
    const instance = createScheduler({ sqliteBackupEnabled: false });
    const result = instance.start();

    expect(result.started).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  test('não cria timers em NODE_ENV=test', () => {
    const instance = createScheduler({ nodeEnv: 'test' });
    const result = instance.start();

    expect(result.started).toBe(false);
    expect(result.reason).toBe('test_environment');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('calcula próxima execução às 08:15 no timezone configurado', () => {
    const instance = createScheduler();
    const snapshot = instance.computeSchedule(new Date('2026-08-07T12:00:00.000Z').getTime());

    const formatted = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(snapshot.nextRunAtMs));

    expect(formatted).toBe('08:15');
  });

  test('startup após horário executa backup perdido uma vez e não duplica no restart', async () => {
    jest.setSystemTime(new Date('2026-08-07T15:00:00.000Z'));
    const instance = createScheduler({ sqliteBackupStartupDelaySeconds: 1 });

    const first = instance.start();
    expect(first.started).toBe(true);

    await jest.advanceTimersByTimeAsync(1000);
    expect(backupService.createBackup).toHaveBeenCalledTimes(1);

    instance.stop();
    instance._resetForTests();

    const secondInstance = createScheduler({ sqliteBackupStartupDelaySeconds: 1 });
    const second = secondInstance.start();
    expect(second.started).toBe(true);

    await jest.advanceTimersByTimeAsync(1000);
    expect(backupService.createBackup).toHaveBeenCalledTimes(1);
  });

  test('falha agenda retry controlado sem loop rápido', async () => {
    backupService.createBackup
      .mockResolvedValueOnce({ success: false, result: 'failed', errorCode: 'X' })
      .mockResolvedValueOnce({ success: true, result: 'ok' });

    jest.setSystemTime(new Date('2026-08-07T15:00:00.000Z'));
    const instance = createScheduler({ sqliteBackupStartupDelaySeconds: 1 });

    instance.start();
    await jest.advanceTimersByTimeAsync(1000);
    expect(backupService.createBackup).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(backupService.createBackup).toHaveBeenCalledTimes(2);
  });

  test('stop cancela timer e é idempotente', () => {
    const instance = createScheduler();
    instance.start();

    const first = instance.stop();
    const second = instance.stop();

    expect(first.stopped).toBe(true);
    expect(second.stopped).toBe(false);
  });
});
