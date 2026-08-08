jest.mock('../src/services/queueMessageService', () => ({
  updatePanel: jest.fn().mockResolvedValue(undefined),
}));

const { createTestContext, getDb } = require('./helpers/testDatabase');

describe('scheduler production timezone behavior', () => {
  let context;
  let schedulerService;
  let client;

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

  beforeEach(async () => {
    jest.resetModules();
    jest.useFakeTimers({ now: new Date('2026-08-07T20:00:00.000-03:00') });

    context = await createTestContext({
      nodeEnv: 'production',
      queueOpenTime: '19:00',
      queueCloseTime: '08:00',
      queueTimezone: 'America/Sao_Paulo',
    });

    schedulerService = require('../src/services/schedulerService');
    client = { user: { id: 'bot-user' }, channels: { cache: new Map() } };
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
  });

  test('às 08:00 fecha automaticamente sem limpar ciclo', async () => {
    const db = getDb(context.sqliteClient);

    setNow('2026-08-07T20:10:00.000-03:00');
    schedulerService.startScheduler(client);
    await settleScheduler();

    const cycleBeforeClose = readCycleId(db);

    await jest.advanceTimersByTimeAsync((11 * 60 + 50) * 60 * 1000);
    await flushTasks();

    expect(schedulerService.isQueueOpen()).toBe(false);
    expect(schedulerService.getStatus().state).toBe('closed');
    expect(readCycleId(db)).toBe(cycleBeforeClose);
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
