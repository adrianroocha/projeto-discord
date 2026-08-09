jest.mock('../src/services/queueMessageService', () => ({
  updatePanel: jest.fn().mockResolvedValue(undefined),
}));

const { createTestContext, getDb } = require('./helpers/testDatabase');
const panelService = require('../src/services/queueMessageService');

describe('scheduler production timezone behavior', () => {
  let context;
  let schedulerService;
  let client;
  let queuePermissionOverwrites;

  async function flushTasks() {
    await Promise.resolve();
    await Promise.resolve();
  }

  async function settleScheduler() {
    await jest.advanceTimersByTimeAsync(1);
    await flushTasks();
  }

  function readCycleId(db) {
    const row = db.prepare('SELECT current_cycle_id AS id FROM queue_cycle_state WHERE id = 1').get();
    return row.id;
  }

  function setNow(isoDateString) {
    jest.setSystemTime(new Date(isoDateString));
  }

  function readSchedulerState(db) {
    return db
      .prepare(
        `SELECT
          current_state,
          state_origin,
          last_scheduled_open_cycle_key,
          last_scheduled_close_cycle_key,
          last_scheduled_open_at_ms,
          last_scheduled_close_at_ms
         FROM scheduler_state
         WHERE id = 1`,
      )
      .get();
  }

  function countRows(db, tableName) {
    return db.prepare(`SELECT COUNT(1) AS c FROM ${tableName}`).get().c;
  }

  function seedDirtyCycle(db) {
    const cycleId = readCycleId(db);
    db.prepare(
      'INSERT INTO queue_entries (discord_id, username, display_name, is_subscriber, joined_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run('waiting-1', 'Waiting#0001', 'Waiting', 0, 1_000);

    db.prepare(
      'INSERT INTO lobbies (created_at_ms, status, creation_type, lobby_number) VALUES (?, ?, ?, ?)',
    ).run(2_000, 'forming', 'automatic', 1);
    db.prepare(
      'INSERT INTO lobbies (created_at_ms, status, creation_type, lobby_number) VALUES (?, ?, ?, ?)',
    ).run(3_000, 'in_game', 'automatic', 2);

    db.prepare(
      'INSERT INTO lobby_players (lobby_id, discord_id, username, display_name, position, original_joined_at_ms, is_subscriber) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(1, 'forming-1', 'Forming#0001', 'Forming', 1, 2_000, 0);
    db.prepare(
      'INSERT INTO lobby_players (lobby_id, discord_id, username, display_name, position, original_joined_at_ms, is_subscriber) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(2, 'in-game-1', 'InGame#0001', 'InGame', 1, 3_000, 0);

    db.prepare(
      'INSERT INTO queue_priority_snapshots (cycle_id, discord_id, is_subscriber, created_at_ms) VALUES (?, ?, ?, ?)',
    ).run(cycleId, 'waiting-1', 0, 1_000);

    return cycleId;
  }

  beforeEach(async () => {
    jest.resetModules();
    jest.useFakeTimers({ now: new Date('2026-08-07T20:00:00.000-03:00') });
    panelService.updatePanel.mockReset();
    panelService.updatePanel.mockResolvedValue(undefined);

    context = await createTestContext({
      nodeEnv: 'production',
      queueOpenTime: '19:00',
      queueCloseTime: '08:00',
      queueTimezone: 'America/Sao_Paulo',
      queueChannelId: 'queue-channel',
    });

    schedulerService = require('../src/services/schedulerService');
    queuePermissionOverwrites = {
      edit: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    client = {
      user: { id: 'bot-user' },
      channels: {
        cache: new Map([
          [
            'queue-channel',
            {
              isTextBased: () => true,
              guild: { roles: { everyone: { id: 'everyone-role' } } },
              permissionOverwrites: queuePermissionOverwrites,
            },
          ],
        ]),
      },
    };
  });

  afterEach(async () => {
    if (schedulerService && typeof schedulerService.stopScheduler === 'function') {
      schedulerService.stopScheduler();
    }

    const lifecycleService = require('../src/services/applicationLifecycleService');
    if (typeof lifecycleService._resetForTests === 'function') {
      lifecycleService._resetForTests();
    }

    if (context && typeof context.cleanup === 'function') {
      await context.cleanup();
    }

    jest.useRealTimers();
  });

  test('de manhã (antes de 19:00) mantém fila fechada no startup e abre às 19:00 no timezone configurado', async () => {
    setNow('2026-08-07T10:00:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(schedulerService.getStatus().state).toBe('closed');

    await jest.advanceTimersByTimeAsync(9 * 60 * 60 * 1000);
    await flushTasks();

    expect(schedulerService.isQueueOpen()).toBe(true);
    expect(schedulerService.getStatus().state).toBe('open');
    expect(schedulerService.getStatus().currentCycleKey).toBe('2026-08-07');
    expect(queuePermissionOverwrites.edit).not.toHaveBeenCalled();
    expect(queuePermissionOverwrites.set).not.toHaveBeenCalled();
  });

  test('após 19:00 aplica abertura agendada uma única vez e não repete no restart', async () => {
    const db = getDb(context.sqliteClient);

    setNow('2026-08-07T20:30:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    const cycleBeforeRestart = readCycleId(db);

    schedulerService.stopScheduler();
    schedulerService.resetSchedulerStopFlag();
    schedulerService.startScheduler(client);
    await settleScheduler();

    expect(readCycleId(db)).toBe(cycleBeforeRestart);
    expect(queuePermissionOverwrites.edit).not.toHaveBeenCalled();
    expect(queuePermissionOverwrites.set).not.toHaveBeenCalled();
  });

  test('restart durante madrugada mantém ciclo do dia de abertura sem novo reset', async () => {
    const db = getDb(context.sqliteClient);

    setNow('2026-08-07T23:50:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    const cycleAfterOpen = readCycleId(db);

    setNow('2026-08-08T01:10:00.000-03:00');
    schedulerService.stopScheduler();
    schedulerService.resetSchedulerStopFlag();
    schedulerService.startScheduler(client);
    await settleScheduler();

    expect(readCycleId(db)).toBe(cycleAfterOpen);
    expect(schedulerService.getStatus().currentCycleKey).toBe('2026-08-07');
    expect(queuePermissionOverwrites.edit).not.toHaveBeenCalled();
  });

  test('às 08:00 fecha automaticamente, finaliza ciclo e limpa estado transacionalmente', async () => {
    const db = getDb(context.sqliteClient);

    setNow('2026-08-07T20:10:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    const cycleBeforeClose = seedDirtyCycle(db);
    expect(countRows(db, 'queue_entries')).toBe(1);
    expect(countRows(db, 'lobby_players')).toBe(2);
    expect(countRows(db, 'lobbies')).toBe(2);
    expect(countRows(db, 'queue_priority_snapshots')).toBe(1);

    await jest.advanceTimersByTimeAsync((11 * 60 + 50) * 60 * 1000);
    await flushTasks();

    const cycleAfterClose = readCycleId(db);
    const schedulerState = readSchedulerState(db);

    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(schedulerService.getStatus().state).toBe('closed');
    expect(countRows(db, 'queue_entries')).toBe(0);
    expect(countRows(db, 'lobby_players')).toBe(0);
    expect(countRows(db, 'lobbies')).toBe(0);
    expect(countRows(db, 'queue_priority_snapshots')).toBe(0);
    expect(cycleAfterClose).toBe(cycleBeforeClose + 1);
    expect(schedulerState.last_scheduled_close_cycle_key).toBe('2026-08-07');
    expect(schedulerState.current_state).toBe('closed');
    expect(schedulerState.state_origin).toBe('scheduled');
    expect(queuePermissionOverwrites.edit).not.toHaveBeenCalled();
    expect(queuePermissionOverwrites.set).not.toHaveBeenCalled();
  });

  test('scheduler-close manual preserva ciclo, fila, lobbies e snapshots', async () => {
    const db = getDb(context.sqliteClient);

    setNow('2026-08-07T20:10:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    const cycleBeforeClose = readCycleId(db);
    seedDirtyCycle(db);

    await schedulerService.closeQueue(client, { manual: true });

    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(schedulerService.getStatus().origin).toBe('manual_close');
    expect(readCycleId(db)).toBe(cycleBeforeClose);
    expect(countRows(db, 'queue_entries')).toBe(1);
    expect(countRows(db, 'lobby_players')).toBe(2);
    expect(countRows(db, 'lobbies')).toBe(2);
    expect(countRows(db, 'queue_priority_snapshots')).toBe(1);
    expect(queuePermissionOverwrites.edit).not.toHaveBeenCalled();
  });

  test('restart às 08:01 não duplica finalização automática já concluída', async () => {
    const db = getDb(context.sqliteClient);

    setNow('2026-08-07T20:10:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();
    seedDirtyCycle(db);

    await jest.advanceTimersByTimeAsync((11 * 60 + 50) * 60 * 1000);
    await flushTasks();

    const cycleAfterClose = readCycleId(db);
    const stateAfterClose = readSchedulerState(db);

    setNow('2026-08-08T08:01:00.000-03:00');
    schedulerService.stopScheduler();
    schedulerService.resetSchedulerStopFlag();
    schedulerService.startScheduler(client);
    await settleScheduler();

    const cycleAfterRestart = readCycleId(db);
    const stateAfterRestart = readSchedulerState(db);

    expect(cycleAfterRestart).toBe(cycleAfterClose);
    expect(stateAfterRestart.last_scheduled_close_cycle_key).toBe(stateAfterClose.last_scheduled_close_cycle_key);
  });

  test('offline às 08:00 e retorno às 10:00 aplica fechamento e limpeza pendente uma vez', async () => {
    const db = getDb(context.sqliteClient);
    const cycleBefore = readCycleId(db);
    seedDirtyCycle(db);

    setNow('2026-08-08T10:00:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    const cycleAfter = readCycleId(db);
    const schedulerState = readSchedulerState(db);

    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(cycleAfter).toBe(cycleBefore + 1);
    expect(countRows(db, 'queue_entries')).toBe(0);
    expect(countRows(db, 'lobby_players')).toBe(0);
    expect(countRows(db, 'lobbies')).toBe(0);
    expect(countRows(db, 'queue_priority_snapshots')).toBe(0);
    expect(schedulerState.last_scheduled_close_cycle_key).toBe('2026-08-07');
  });

  test('offline antes das 08:00 e retorno após 19:00 finaliza anterior e abre ciclo novo vazio sem duplicar incremento', async () => {
    const db = getDb(context.sqliteClient);
    const cycleBefore = readCycleId(db);
    seedDirtyCycle(db);

    setNow('2026-08-08T20:00:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    const cycleAfter = readCycleId(db);
    const schedulerState = readSchedulerState(db);

    expect(schedulerService.isQueueOpen()).toBe(true);
    expect(schedulerService.getStatus().currentCycleKey).toBe('2026-08-08');
    expect(cycleAfter).toBe(cycleBefore + 1);
    expect(countRows(db, 'queue_entries')).toBe(0);
    expect(countRows(db, 'lobby_players')).toBe(0);
    expect(countRows(db, 'lobbies')).toBe(0);
    expect(countRows(db, 'queue_priority_snapshots')).toBe(0);
    expect(schedulerState.last_scheduled_close_cycle_key).toBe('2026-08-07');
    expect(schedulerState.last_scheduled_open_cycle_key).toBe('2026-08-08');
  });

  test('restart durante janela aberta preserva dados e não cria novo ciclo', async () => {
    const db = getDb(context.sqliteClient);

    setNow('2026-08-08T20:10:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    seedDirtyCycle(db);
    const cycleBeforeRestart = readCycleId(db);

    setNow('2026-08-08T21:10:00.000-03:00');
    schedulerService.stopScheduler();
    schedulerService.resetSchedulerStopFlag();
    schedulerService.startScheduler(client);
    await settleScheduler();

    expect(schedulerService.isQueueOpen()).toBe(true);
    expect(readCycleId(db)).toBe(cycleBeforeRestart);
    expect(countRows(db, 'queue_entries')).toBe(1);
    expect(countRows(db, 'lobby_players')).toBe(2);
    expect(countRows(db, 'lobbies')).toBe(2);
    expect(countRows(db, 'queue_priority_snapshots')).toBe(1);
  });

  test('múltiplas reconciliações no mesmo instante resultam em uma única finalização efetiva', async () => {
    const db = getDb(context.sqliteClient);

    setNow('2026-08-07T20:10:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    const cycleBeforeClose = seedDirtyCycle(db);
    const closeNowMs = new Date('2026-08-08T08:00:00.000-03:00').getTime();

    await Promise.all([
      schedulerService._private.reconcileProductionState(client, { nowMs: closeNowMs }),
      schedulerService._private.reconcileProductionState(client, { nowMs: closeNowMs }),
      schedulerService._private.reconcileProductionState(client, { nowMs: closeNowMs }),
    ]);

    expect(readCycleId(db)).toBe(cycleBeforeClose + 1);
    expect(countRows(db, 'queue_entries')).toBe(0);
    expect(countRows(db, 'queue_priority_snapshots')).toBe(0);
  });

  test('falha na limpeza automática faz rollback e não marca ciclo como finalizado', async () => {
    const db = getDb(context.sqliteClient);

    setNow('2026-08-07T20:10:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();
    const cycleBeforeClose = seedDirtyCycle(db);

    db.exec(`
      CREATE TRIGGER fail_delete_lobby_players
      BEFORE DELETE ON lobby_players
      BEGIN
        SELECT RAISE(ABORT, 'forced_auto_close_failure');
      END;
    `);

    const closeNowMs = new Date('2026-08-08T08:00:00.000-03:00').getTime();

    expect(() => {
      schedulerService._private.finalizeCycleForScheduledClose('2026-08-07', closeNowMs);
    }).toThrow('forced_auto_close_failure');

    const schedulerState = readSchedulerState(db);

    expect(readCycleId(db)).toBe(cycleBeforeClose);
    expect(countRows(db, 'queue_entries')).toBe(1);
    expect(countRows(db, 'lobby_players')).toBe(2);
    expect(countRows(db, 'lobbies')).toBe(2);
    expect(countRows(db, 'queue_priority_snapshots')).toBe(1);
    expect(schedulerState.last_scheduled_close_cycle_key).not.toBe('2026-08-07');
  });

  test('falha de painel após finalização automática não desfaz banco e reconciliação seguinte mantém consistência', async () => {
    const db = getDb(context.sqliteClient);

    setNow('2026-08-07T20:10:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();
    const cycleBeforeClose = seedDirtyCycle(db);

    panelService.updatePanel.mockRejectedValueOnce(new Error('panel down'));
    const closeNowMs = new Date('2026-08-08T08:00:00.000-03:00').getTime();
    await expect(
      schedulerService._private.reconcileProductionState(client, { nowMs: closeNowMs }),
    ).resolves.toBeUndefined();

    expect(readCycleId(db)).toBe(cycleBeforeClose + 1);
    expect(countRows(db, 'queue_entries')).toBe(0);
    expect(countRows(db, 'lobby_players')).toBe(0);
    expect(countRows(db, 'lobbies')).toBe(0);
    expect(countRows(db, 'queue_priority_snapshots')).toBe(0);

    panelService.updatePanel.mockResolvedValue(undefined);
    const recoverNowMs = new Date('2026-08-08T10:00:00.000-03:00').getTime();
    await expect(
      schedulerService._private.reconcileProductionState(client, { nowMs: recoverNowMs }),
    ).resolves.toBeUndefined();
  });

  test('override manual de fechamento persiste até próxima abertura agendada', async () => {
    setNow('2026-08-07T20:10:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    await schedulerService.closeQueue(client, { manual: true });
    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(schedulerService.getStatus().origin).toBe('manual_close');

    setNow('2026-08-08T07:30:00.000-03:00');
    schedulerService.stopScheduler();
    schedulerService.resetSchedulerStopFlag();
    schedulerService.startScheduler(client);
    await settleScheduler();

    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(schedulerService.getStatus().origin).toBe('manual_close');

    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    await flushTasks();

    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(schedulerService.getStatus().origin).toBe('scheduled');
  });

  test('override manual de abertura persiste até a próxima transição agendada', async () => {
    setNow('2026-08-08T10:00:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    expect(schedulerService.isQueueOpen()).toBe(false);

    await schedulerService.openQueue(client, { manual: true });
    expect(schedulerService.isQueueOpen()).toBe(true);
    expect(schedulerService.getStatus().origin).toBe('manual_open');

    setNow('2026-08-09T07:50:00.000-03:00');
    schedulerService.stopScheduler();
    schedulerService.resetSchedulerStopFlag();
    schedulerService.startScheduler(client);
    await settleScheduler();

    expect(schedulerService.isQueueOpen()).toBe(true);
    expect(schedulerService.getStatus().origin).toBe('scheduled');

    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    await flushTasks();

    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(schedulerService.getStatus().origin).toBe('scheduled');
  });

  test('scheduler-status exibe origem e timezone configurado em produção', async () => {
    setNow('2026-08-07T20:10:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    const status = schedulerService.getStatus();

    expect(status.mode).toBe('production');
    expect(status.origin).toBe('scheduled');
    expect(status.timezone).toBe('America/Sao_Paulo');
    expect(status.configuredOpenTime).toBe('19:00');
    expect(status.configuredCloseTime).toBe('08:00');
    expect(status.currentCycleKey).toBe('2026-08-07');
  });

  test('inválido: timezone IANA inválido gera erro explícito', async () => {
    const schedulerTimeService = require('../src/services/schedulerTimeService');

    expect(() => {
      schedulerTimeService.computeScheduleSnapshot({
        nowMs: Date.now(),
        openTime: '19:00',
        closeTime: '08:00',
        timeZone: 'Foo/Bar',
      });
    }).toThrow(/QUEUE_TIMEZONE inválido/);
  });

  test('inválido: formato de horário inválido gera erro explícito', async () => {
    const schedulerTimeService = require('../src/services/schedulerTimeService');

    expect(() => {
      schedulerTimeService.computeScheduleSnapshot({
        nowMs: Date.now(),
        openTime: '25:99',
        closeTime: '08:00',
        timeZone: 'America/Sao_Paulo',
      });
    }).toThrow(/QUEUE_OPEN_TIME inválido/);
  });
});
