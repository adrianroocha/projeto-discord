const { createTestContext, getDb, seedQueueEntry } = require('./helpers/testDatabase');

function insertAuditRow(db, payload) {
  db.prepare(
    `INSERT INTO admin_command_audit_logs (
      interaction_id,
      guild_id,
      channel_id,
      actor_discord_id,
      actor_username,
      command_name,
      parameters_json,
      queue_cycle_id,
      previous_state_json,
      next_state_json,
      result,
      error_code,
      started_at_ms,
      finished_at_ms,
      created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    payload.interactionId,
    'guild-1',
    'channel-1',
    'mod-1',
    'mod',
    'scheduler-open',
    '{}',
    1,
    '{}',
    '{}',
    payload.result,
    payload.errorCode || null,
    payload.startedAtMs,
    payload.finishedAtMs || payload.startedAtMs,
    payload.createdAtMs || payload.startedAtMs,
  );
}

describe('admin audit retention policy', () => {
  let context;
  let repository;

  beforeEach(async () => {
    jest.useFakeTimers();
    context = await createTestContext({ nodeEnv: 'test' });
    repository = require('../src/database/adminCommandAuditLogsRepository');
  });

  afterEach(async () => {
    await context.cleanup();
    jest.useRealTimers();
  });

  test('deleteOlderThan remove 31 dias, preserva 29 dias e fronteira exata', () => {
    const db = getDb(context.sqliteClient);
    const nowMs = Date.UTC(2026, 7, 9, 12, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    const cutoffMs = nowMs - 30 * dayMs;

    insertAuditRow(db, {
      interactionId: 'old-31',
      result: 'success',
      startedAtMs: nowMs - 31 * dayMs,
    });
    insertAuditRow(db, {
      interactionId: 'recent-29',
      result: 'failed',
      startedAtMs: nowMs - 29 * dayMs,
    });
    insertAuditRow(db, {
      interactionId: 'edge-30',
      result: 'denied',
      startedAtMs: cutoffMs,
    });

    const removed = repository.deleteOlderThan(cutoffMs);

    expect(removed).toBe(1);
    expect(repository.findByInteractionId('old-31')).toBeNull();
    expect(repository.findByInteractionId('recent-29')).toBeTruthy();
    expect(repository.findByInteractionId('edge-30')).toBeTruthy();
  });

  test('remove resultados antigos success/failed/denied/pending e preserva recentes', () => {
    const db = getDb(context.sqliteClient);
    const nowMs = Date.UTC(2026, 7, 9, 12, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    const cutoffMs = nowMs - 30 * dayMs;

    const oldRows = [
      { id: 'old-success', result: 'success' },
      { id: 'old-failed', result: 'failed' },
      { id: 'old-denied', result: 'denied' },
      { id: 'old-pending', result: 'pending' },
    ];

    const recentRows = [
      { id: 'new-success', result: 'success' },
      { id: 'new-failed', result: 'failed' },
      { id: 'new-denied', result: 'denied' },
      { id: 'new-pending', result: 'pending' },
    ];

    for (const row of oldRows) {
      insertAuditRow(db, {
        interactionId: row.id,
        result: row.result,
        startedAtMs: nowMs - 31 * dayMs,
      });
    }

    for (const row of recentRows) {
      insertAuditRow(db, {
        interactionId: row.id,
        result: row.result,
        startedAtMs: nowMs - 10 * dayMs,
      });
    }

    const removed = repository.deleteOlderThan(cutoffMs);
    expect(removed).toBe(4);

    for (const row of oldRows) {
      expect(repository.findByInteractionId(row.id)).toBeNull();
    }

    for (const row of recentRows) {
      expect(repository.findByInteractionId(row.id)).toBeTruthy();
    }
  });

  test('não altera outras tabelas', () => {
    const db = getDb(context.sqliteClient);
    const nowMs = Date.UTC(2026, 7, 9, 12, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    const cutoffMs = nowMs - 30 * dayMs;

    seedQueueEntry(db, {
      id: 1,
      discordId: 'queue-user',
      username: 'Queue User#0001',
      displayName: 'Queue User',
      isSubscriber: false,
      joinedAtMs: nowMs,
    });

    insertAuditRow(db, {
      interactionId: 'old-1',
      result: 'success',
      startedAtMs: nowMs - 31 * dayMs,
    });

    const beforeQueueCount = db.prepare('SELECT COUNT(1) AS c FROM queue_entries').get().c;
    repository.deleteOlderThan(cutoffMs);
    const afterQueueCount = db.prepare('SELECT COUNT(1) AS c FROM queue_entries').get().c;

    expect(beforeQueueCount).toBe(1);
    expect(afterQueueCount).toBe(1);
  });

  test('deleteOlderThan usa query parametrizada e retorna removidos', () => {
    const db = getDb(context.sqliteClient);
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = jest.spyOn(db, 'prepare');

    const nowMs = Date.UTC(2026, 7, 9, 12, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    const cutoffMs = nowMs - 30 * dayMs;

    insertAuditRow(db, {
      interactionId: 'old-1',
      result: 'success',
      startedAtMs: nowMs - 40 * dayMs,
    });

    const removed = repository.deleteOlderThan(cutoffMs);
    expect(removed).toBe(1);

    const deleteCall = prepareSpy.mock.calls.find((call) => String(call[0]).includes('DELETE FROM admin_command_audit_logs'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toContain('started_at_ms < ?');

    // restore manually because we spied on concrete db object
    db.prepare = originalPrepare;
  });

  test('scheduler startup limpa uma vez e não inicia timer real em test', async () => {
    const db = getDb(context.sqliteClient);
    const nowMs = Date.UTC(2026, 7, 9, 12, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;

    insertAuditRow(db, {
      interactionId: 'old-1',
      result: 'success',
      startedAtMs: nowMs - 31 * dayMs,
    });

    const schedulerFactory = require('../src/services/adminAuditRetentionScheduler').createAdminAuditRetentionScheduler;
    const scheduler = schedulerFactory({
      config: {
        adminAuditRetentionDays: 30,
        nodeEnv: 'test',
      },
      lifecycleService: { isShuttingDown: jest.fn().mockReturnValue(false) },
      adminCommandAuditLogsRepository: repository,
      logger: { info: jest.fn(), warn: jest.fn() },
      now: () => nowMs,
    });

    const result = await scheduler.start();
    expect(result.started).toBe(true);
    expect(result.reason).toBe('test_environment_no_timer');
    expect(repository.findByInteractionId('old-1')).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('scheduler não inicia duas vezes e stop é idempotente', async () => {
    const schedulerFactory = require('../src/services/adminAuditRetentionScheduler').createAdminAuditRetentionScheduler;
    const scheduler = schedulerFactory({
      config: {
        adminAuditRetentionDays: 30,
        nodeEnv: 'production',
      },
      lifecycleService: { isShuttingDown: jest.fn().mockReturnValue(false) },
      adminCommandAuditLogsRepository: repository,
      logger: { info: jest.fn(), warn: jest.fn() },
      now: () => Date.UTC(2026, 7, 9, 12, 0, 0),
    });

    const first = await scheduler.start();
    const second = await scheduler.start();

    expect(first.started).toBe(true);
    expect(second).toEqual({ started: false, reason: 'already_started' });

    const stopFirst = scheduler.stop();
    const stopSecond = scheduler.stop();
    expect(stopFirst).toEqual({ stopped: true });
    expect(stopSecond).toEqual({ stopped: false, reason: 'already_stopped' });
  });

  test('não reagenda durante shutdown', async () => {
    const lifecycle = { isShuttingDown: jest.fn().mockReturnValue(false) };
    const schedulerFactory = require('../src/services/adminAuditRetentionScheduler').createAdminAuditRetentionScheduler;
    const scheduler = schedulerFactory({
      config: {
        adminAuditRetentionDays: 30,
        nodeEnv: 'production',
      },
      lifecycleService: lifecycle,
      adminCommandAuditLogsRepository: repository,
      logger: { info: jest.fn(), warn: jest.fn() },
      now: () => Date.UTC(2026, 7, 9, 12, 0, 0),
    });

    await scheduler.start();
    expect(jest.getTimerCount()).toBe(1);

    lifecycle.isShuttingDown.mockReturnValue(true);
    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 10);

    expect(jest.getTimerCount()).toBe(0);
  });

  test('falha de limpeza não derruba e registra warning seguro', async () => {
    const failingRepository = {
      deleteOlderThan: jest.fn(() => {
        throw new Error('database down');
      }),
    };

    const logger = { info: jest.fn(), warn: jest.fn() };
    const schedulerFactory = require('../src/services/adminAuditRetentionScheduler').createAdminAuditRetentionScheduler;
    const scheduler = schedulerFactory({
      config: {
        adminAuditRetentionDays: 30,
        nodeEnv: 'test',
      },
      lifecycleService: { isShuttingDown: jest.fn().mockReturnValue(false) },
      adminCommandAuditLogsRepository: failingRepository,
      logger,
      now: () => Date.UTC(2026, 7, 9, 12, 0, 0),
    });

    const result = await scheduler.start();
    expect(result.started).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith('Admin audit retention failed code=ADMIN_AUDIT_RETENTION_FAILED');
  });

  test('scheduler limpa novamente a cada 24h no máximo uma vez por ciclo', async () => {
    const deleteOlderThan = jest.fn(() => 0);
    const schedulerFactory = require('../src/services/adminAuditRetentionScheduler').createAdminAuditRetentionScheduler;
    const scheduler = schedulerFactory({
      config: {
        adminAuditRetentionDays: 30,
        nodeEnv: 'production',
      },
      lifecycleService: { isShuttingDown: jest.fn().mockReturnValue(false) },
      adminCommandAuditLogsRepository: { deleteOlderThan },
      logger: { info: jest.fn(), warn: jest.fn() },
      now: () => Date.UTC(2026, 7, 9, 12, 0, 0),
    });

    await scheduler.start();
    expect(deleteOlderThan).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 5);
    expect(deleteOlderThan).toHaveBeenCalledTimes(2);
  });
});
