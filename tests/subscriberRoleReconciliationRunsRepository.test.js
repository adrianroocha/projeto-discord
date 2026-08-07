const { createTestContext, getDb } = require('./helpers/testDatabase');

describe('subscriberRoleReconciliationRunsRepository', () => {
  let context;
  let db;
  let repository;

  beforeEach(async () => {
    context = await createTestContext();
    db = getDb(context.sqliteClient);
    repository = require('../src/database/subscriberRoleReconciliationRunsRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('cria tabela de auditoria de execuções em massa', () => {
    const row = db
      .prepare(
        "SELECT COUNT(1) AS count FROM sqlite_master WHERE type='table' AND name='subscriber_role_reconciliation_runs'",
      )
      .get();

    expect(row.count).toBe(1);
  });

  test('registra início e finalização da execução', () => {
    const id = repository.registerStarted({
      triggerType: 'command_sub_reconcile',
      triggeredByDiscordId: 'admin-1',
      reason: 'Teste execução em massa',
      startedAtMs: 1000,
    });

    repository.registerFinished({
      id,
      finishedAtMs: 2000,
      totalCandidates: 10,
      processed: 10,
      roleAdded: 3,
      roleRemoved: 2,
      alreadyCorrect: 4,
      skipped: 1,
      failed: 0,
      status: 'completed',
    });

    const latest = repository.findLatest();
    expect(latest).toMatchObject({
      id,
      trigger_type: 'command_sub_reconcile',
      triggered_by_discord_id: 'admin-1',
      total_candidates: 10,
      processed: 10,
      role_added: 3,
      role_removed: 2,
      already_correct: 4,
      skipped: 1,
      failed: 0,
      status: 'completed',
    });
  });

  test('permite triggered_by_discord_id nulo', () => {
    const id = repository.registerStarted({
      triggerType: 'scheduler_sub_reconcile',
      triggeredByDiscordId: null,
      reason: 'Scheduler',
      startedAtMs: 1000,
    });

    repository.registerFinished({
      id,
      finishedAtMs: 1200,
      totalCandidates: 0,
      processed: 0,
      roleAdded: 0,
      roleRemoved: 0,
      alreadyCorrect: 0,
      skipped: 0,
      failed: 0,
      status: 'completed',
    });

    const latest = repository.findLatest();
    expect(latest.triggered_by_discord_id).toBeNull();
    expect(repository.countAll()).toBe(1);
  });
});
