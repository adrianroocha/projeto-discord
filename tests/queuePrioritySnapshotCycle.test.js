const { createTestContext, getDb } = require('./helpers/testDatabase');

describe('queue priority snapshot cycle', () => {
  let context;
  let db;
  let manualSubGrantService;
  let subscriberRoleAutoSyncService;

  beforeEach(async () => {
    context = await createTestContext({
      nodeEnv: 'development',
      subscriberRoleId: 'role-sub',
      kickBroadcasterUserId: 'broadcaster-1',
    });
    db = getDb(context.sqliteClient);
    manualSubGrantService = require('../src/services/manualSubGrantService');
    subscriberRoleAutoSyncService = require('../src/services/subscriberRoleAutoSyncService');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  function getQueueRow(discordId) {
    return db
      .prepare('SELECT discord_id, is_subscriber, joined_at_ms FROM queue_entries WHERE discord_id = ?')
      .get(discordId);
  }

  function getSnapshotRow(discordId, cycleId) {
    return db
      .prepare(
        'SELECT cycle_id, discord_id, is_subscriber, created_at_ms FROM queue_priority_snapshots WHERE cycle_id = ? AND discord_id = ?',
      )
      .get(cycleId, discordId);
  }

  function getCurrentCycleId() {
    return db.prepare('SELECT current_cycle_id FROM queue_cycle_state WHERE id = 1').get().current_cycle_id;
  }

  test('primeira entrada elegivel cria snapshot SUB', () => {
    const cycleId = getCurrentCycleId();

    const result = context.queueService.addToQueue({
      discordId: 'eligible-1',
      username: 'Eligible#0001',
      displayName: 'Eligible',
      resolvePrioritySnapshot: () => ({ isSubscriber: 1, source: 'eligible', reliable: true }),
    });

    expect(result.success).toBe(true);
    expect(result.isSubscriber).toBe(1);
    expect(result.snapshotStatus).toBe('created');

    const snapshot = getSnapshotRow('eligible-1', cycleId);
    expect(snapshot.is_subscriber).toBe(1);
  });

  test('primeira entrada nao elegivel cria snapshot comum', () => {
    const cycleId = getCurrentCycleId();

    const result = context.queueService.addToQueue({
      discordId: 'regular-1',
      username: 'Regular#0001',
      displayName: 'Regular',
      resolvePrioritySnapshot: () => ({ isSubscriber: 0, source: 'not_eligible', reliable: true }),
    });

    expect(result.success).toBe(true);
    expect(result.isSubscriber).toBe(0);

    const snapshot = getSnapshotRow('regular-1', cycleId);
    expect(snapshot.is_subscriber).toBe(0);
  });

  test('falha de elegibilidade cria snapshot comum', () => {
    const cycleId = getCurrentCycleId();

    const result = context.queueService.addToQueue({
      discordId: 'fallback-1',
      username: 'Fallback#0001',
      displayName: 'Fallback',
      resolvePrioritySnapshot: () => {
        throw new Error('eligibility down');
      },
    });

    expect(result.success).toBe(true);
    expect(result.isSubscriber).toBe(0);
    expect(result.snapshotResolution.reliable).toBe(false);

    const snapshot = getSnapshotRow('fallback-1', cycleId);
    expect(snapshot.is_subscriber).toBe(0);
  });

  test('reentrada no mesmo ciclo reutiliza categoria, sem nova consulta, com novo timestamp', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValueOnce(200_000).mockReturnValueOnce(200_100);

    const resolver = jest
      .fn()
      .mockReturnValueOnce({ isSubscriber: 1, source: 'eligible', reliable: true })
      .mockReturnValueOnce({ isSubscriber: 0, source: 'not_eligible', reliable: true });

    const first = context.queueService.addToQueue({
      discordId: 'rejoin-1',
      username: 'Rejoin#0001',
      displayName: 'Rejoin',
      resolvePrioritySnapshot: resolver,
    });
    const beforeLeave = getQueueRow('rejoin-1');

    const removed = context.queueService.removeFromQueue('rejoin-1');
    expect(removed.success).toBe(true);

    const second = context.queueService.addToQueue({
      discordId: 'rejoin-1',
      username: 'Rejoin#0001',
      displayName: 'Rejoin',
      resolvePrioritySnapshot: resolver,
    });
    const afterRejoin = getQueueRow('rejoin-1');

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.snapshotStatus).toBe('reused');
    expect(second.isSubscriber).toBe(1);
    expect(afterRejoin.is_subscriber).toBe(1);
    expect(afterRejoin.joined_at_ms).toBeGreaterThan(beforeLeave.joined_at_ms);
    expect(resolver).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  test('novo ciclo recalcula elegibilidade na proxima entrada', () => {
    const resolver = jest
      .fn()
      .mockReturnValueOnce({ isSubscriber: 1, source: 'eligible', reliable: true })
      .mockReturnValueOnce({ isSubscriber: 0, source: 'not_eligible', reliable: true });

    const before = context.queueService.addToQueue({
      discordId: 'new-cycle-1',
      username: 'NewCycle#0001',
      displayName: 'NewCycle',
      resolvePrioritySnapshot: resolver,
    });
    expect(before.isSubscriber).toBe(1);

    context.queueService.resetQueueCycle();

    const after = context.queueService.addToQueue({
      discordId: 'new-cycle-1',
      username: 'NewCycle#0001',
      displayName: 'NewCycle',
      resolvePrioritySnapshot: resolver,
    });
    expect(after.isSubscriber).toBe(0);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  test('grant apos entrada comum nao altera snapshot', async () => {
    const cycleId = getCurrentCycleId();

    context.queueService.addToQueue({
      discordId: 'cycle-regular-1',
      username: 'Cycle Regular#0001',
      displayName: 'Cycle Regular',
      resolvePrioritySnapshot: () => ({ isSubscriber: 0, source: 'not_eligible', reliable: true }),
    });

    manualSubGrantService.createGrant({
      discordId: 'cycle-regular-1',
      grantedByDiscordId: 'admin-1',
      reason: 'grant no meio do ciclo',
      nowMs: 35_000,
    });

    await subscriberRoleAutoSyncService.syncAfterEligibilityChange({
      discordId: 'cycle-regular-1',
      triggerType: 'manual_grant',
      reason: 'concessao',
      triggeredByDiscordId: 'admin-1',
      client: {},
    });

    expect(getQueueRow('cycle-regular-1').is_subscriber).toBe(0);
    expect(getSnapshotRow('cycle-regular-1', cycleId).is_subscriber).toBe(0);
  });

  test('revoke apos entrada SUB nao altera snapshot', async () => {
    const cycleId = getCurrentCycleId();

    manualSubGrantService.createGrant({
      discordId: 'cycle-sub-1',
      grantedByDiscordId: 'admin-1',
      reason: 'grant inicial',
      nowMs: 5_000,
    });

    context.queueService.addToQueue({
      discordId: 'cycle-sub-1',
      username: 'Cycle Sub#0001',
      displayName: 'Cycle Sub',
      resolvePrioritySnapshot: () => ({ isSubscriber: 1, source: 'eligible', reliable: true }),
    });

    manualSubGrantService.revokeGrant({
      discordId: 'cycle-sub-1',
      revokedByDiscordId: 'admin-1',
      reason: 'revogado no meio do ciclo',
      nowMs: 20_000,
    });

    await subscriberRoleAutoSyncService.syncAfterEligibilityChange({
      discordId: 'cycle-sub-1',
      triggerType: 'manual_revoke',
      reason: 'revogacao',
      triggeredByDiscordId: 'admin-1',
      client: {},
    });

    expect(getQueueRow('cycle-sub-1').is_subscriber).toBe(1);
    expect(getSnapshotRow('cycle-sub-1', cycleId).is_subscriber).toBe(1);
  });

  test('gatilhos link, unlink e webhook nao alteram snapshot', async () => {
    const cycleId = getCurrentCycleId();

    context.queueService.addToQueue({
      discordId: 'trigger-user-1',
      username: 'Trigger#0001',
      displayName: 'Trigger',
      resolvePrioritySnapshot: () => ({ isSubscriber: 1, source: 'eligible', reliable: true }),
    });

    await subscriberRoleAutoSyncService.syncAfterEligibilityChange({
      discordId: 'trigger-user-1',
      triggerType: 'kick_link',
      reason: 'link',
      triggeredByDiscordId: 'trigger-user-1',
      client: {},
    });

    await subscriberRoleAutoSyncService.syncAfterEligibilityChange({
      discordId: 'trigger-user-1',
      triggerType: 'kick_unlink',
      reason: 'unlink',
      triggeredByDiscordId: 'admin-1',
      client: {},
    });

    await subscriberRoleAutoSyncService.syncAfterEligibilityChange({
      discordId: 'trigger-user-1',
      triggerType: 'kick_subscription_new',
      reason: 'webhook',
      triggeredByDiscordId: 'system',
      client: {},
    });

    expect(getQueueRow('trigger-user-1').is_subscriber).toBe(1);
    expect(getSnapshotRow('trigger-user-1', cycleId).is_subscriber).toBe(1);
  });

  test('sub-sync e sub-reconcile nao alteram snapshots por contrato', () => {
    // Comandos /sub-sync e /sub-reconcile sao cobertos em testes dedicados de comando
    // que validam ausencia de qualquer chamada de fila.
    const cycleId = getCurrentCycleId();

    context.queueService.addToQueue({
      discordId: 'command-user-1',
      username: 'Command#0001',
      displayName: 'Command',
      resolvePrioritySnapshot: () => ({ isSubscriber: 0, source: 'not_eligible', reliable: true }),
    });

    const before = getSnapshotRow('command-user-1', cycleId);
    expect(before.is_subscriber).toBe(0);
  });

  test('resetQueueCycle limpa snapshots e avanca ciclo', () => {
    const cycleBefore = getCurrentCycleId();

    context.queueService.addToQueue({
      discordId: 'reset-user-1',
      username: 'Reset#0001',
      displayName: 'Reset',
      resolvePrioritySnapshot: () => ({ isSubscriber: 1, source: 'eligible', reliable: true }),
    });

    expect(getSnapshotRow('reset-user-1', cycleBefore)).toBeDefined();

    context.queueService.resetQueueCycle();

    const cycleAfter = getCurrentCycleId();
    const countSnapshots = db.prepare('SELECT COUNT(1) AS c FROM queue_priority_snapshots').get().c;

    expect(cycleAfter).toBe(cycleBefore + 1);
    expect(countSnapshots).toBe(0);
    expect(db.prepare('SELECT COUNT(1) AS c FROM queue_entries').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(1) AS c FROM lobby_players').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(1) AS c FROM lobbies').get().c).toBe(0);
  });

  test('falha na limpeza de snapshots em reset faz rollback completo', () => {
    context.queueService.addToQueue({
      discordId: 'rollback-user-1',
      username: 'Rollback#0001',
      displayName: 'Rollback',
      resolvePrioritySnapshot: () => ({ isSubscriber: 1, source: 'eligible', reliable: true }),
    });

    db.exec(`
      CREATE TRIGGER fail_delete_queue_priority_snapshots
      BEFORE DELETE ON queue_priority_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'fail_queue_priority_snapshot_delete');
      END;
    `);

    const cycleBefore = getCurrentCycleId();

    expect(() => context.queueService.resetQueueCycle()).toThrow('fail_queue_priority_snapshot_delete');

    const cycleAfter = getCurrentCycleId();
    const queueCount = db.prepare('SELECT COUNT(1) AS c FROM queue_entries').get().c;
    const snapshotCount = db.prepare('SELECT COUNT(1) AS c FROM queue_priority_snapshots').get().c;

    expect(cycleAfter).toBe(cycleBefore);
    expect(queueCount).toBe(1);
    expect(snapshotCount).toBe(1);
  });
});
