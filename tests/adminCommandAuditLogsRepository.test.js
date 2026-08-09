const { createTestContext, getDb } = require('./helpers/testDatabase');

describe('adminCommandAuditLogsRepository', () => {
  let context;
  let repository;

  beforeEach(async () => {
    context = await createTestContext({ nodeEnv: 'test' });
    repository = require('../src/database/adminCommandAuditLogsRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('migration é idempotente e cria tabela/indices esperados', async () => {
    await context.database.initDatabase();

    const db = getDb(context.sqliteClient);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_command_audit_logs'")
      .get();

    expect(table).toBeDefined();

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('uniq_admin_command_audit_interaction_id', 'idx_admin_command_audit_actor_discord_id', 'idx_admin_command_audit_command_name', 'idx_admin_command_audit_started_at_ms')",
      )
      .all()
      .map((row) => row.name)
      .sort();

    expect(indexes).toEqual([
      'idx_admin_command_audit_actor_discord_id',
      'idx_admin_command_audit_command_name',
      'idx_admin_command_audit_started_at_ms',
      'uniq_admin_command_audit_interaction_id',
    ]);
  });

  test('registra pending e finaliza success com metadados seguros', () => {
    const pending = repository.registerPending({
      interactionId: 'int-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      actorDiscordId: 'mod-1',
      actorUsername: 'moderador',
      commandName: 'scheduler-open',
      parameters: { quantidade: 4 },
      queueCycleId: 7,
      previousState: { state: 'closed' },
      startedAtMs: 1000,
      createdAtMs: 1000,
    });

    expect(pending.result).toBe('pending');
    expect(pending.wasCreated).toBe(true);

    const done = repository.finalizeById(pending.id, {
      result: 'success',
      errorCode: 'OK',
      queueCycleId: 8,
      nextState: { state: 'open', manualCycleReset: true },
      finishedAtMs: 2000,
    });

    expect(done.result).toBe('success');
    expect(done.errorCode).toBe('OK');
    expect(done.finishedAtMs).toBe(2000);
    expect(JSON.parse(done.parametersJson)).toEqual({ quantidade: 4 });
    expect(JSON.parse(done.nextStateJson)).toEqual({ state: 'open', manualCycleReset: true });
  });

  test('idempotencia por interaction_id evita duplicidade', () => {
    const first = repository.registerPending({
      interactionId: 'same-int',
      actorDiscordId: 'mod-1',
      actorUsername: 'mod',
      commandName: 'lobby-start',
      startedAtMs: 1000,
      createdAtMs: 1000,
    });

    const second = repository.registerPending({
      interactionId: 'same-int',
      actorDiscordId: 'mod-2',
      actorUsername: 'mod2',
      commandName: 'lobby-start',
      startedAtMs: 2000,
      createdAtMs: 2000,
    });

    expect(first.id).toBe(second.id);
    expect(second.wasCreated).toBe(false);
    expect(repository.countAll()).toBe(1);
  });

  test('nao persiste stack trace ou mensagem interna por padrao', () => {
    const pending = repository.registerPending({
      interactionId: 'int-safe',
      actorDiscordId: 'mod-1',
      actorUsername: 'mod',
      commandName: 'scheduler-close',
      parameters: { raw: 'safe' },
      startedAtMs: 1000,
      createdAtMs: 1000,
    });

    const finalized = repository.finalizeById(pending.id, {
      result: 'failed',
      errorCode: 'INTERNAL_ERROR',
      finishedAtMs: 2000,
    });

    expect(finalized.errorCode).toBe('INTERNAL_ERROR');
    expect(finalized.parametersJson).toContain('safe');
    expect(finalized.parametersJson).not.toContain('stack');
    expect(finalized.parametersJson).not.toContain('token');
    expect(finalized.parametersJson).not.toContain('secret');
  });

  test('mantem operacao normal apos restart no mesmo SQLite', async () => {
    repository.registerPending({
      interactionId: 'persist-after-restart',
      actorDiscordId: 'mod-restart',
      actorUsername: 'modRestart',
      commandName: 'scheduler-open',
      startedAtMs: 1000,
      createdAtMs: 1000,
    });

    await context.sqliteClient.closeConnection();
    await context.database.initDatabase();

    const afterRestart = repository.findByInteractionId('persist-after-restart');
    expect(afterRestart).toBeDefined();
    expect(afterRestart.commandName).toBe('scheduler-open');
  });
});
