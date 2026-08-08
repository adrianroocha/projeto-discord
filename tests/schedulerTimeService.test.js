const schedulerTimeService = require('../src/services/schedulerTimeService');

describe('schedulerTimeService (America/Sao_Paulo)', () => {
  function snapshotAt(isoUtc) {
    return schedulerTimeService.computeScheduleSnapshot({
      nowMs: new Date(isoUtc).getTime(),
      openTime: '19:00',
      closeTime: '08:00',
      timeZone: 'America/Sao_Paulo',
    });
  }

  test('18:59 fechado', () => {
    const snapshot = snapshotAt('2026-08-07T21:59:00.000Z');
    expect(snapshot.expectedState).toBe('closed');
  });

  test('19:00 aberto', () => {
    const snapshot = snapshotAt('2026-08-07T22:00:00.000Z');
    expect(snapshot.expectedState).toBe('open');
    expect(snapshot.currentCycleKey).toBe('2026-08-07');
  });

  test('23:59 aberto', () => {
    const snapshot = snapshotAt('2026-08-08T02:59:00.000Z');
    expect(snapshot.expectedState).toBe('open');
    expect(snapshot.currentCycleKey).toBe('2026-08-07');
  });

  test('00:00 aberto no ciclo anterior', () => {
    const snapshot = snapshotAt('2026-08-08T03:00:00.000Z');
    expect(snapshot.expectedState).toBe('open');
    expect(snapshot.currentCycleKey).toBe('2026-08-07');
  });

  test('07:59 aberto', () => {
    const snapshot = snapshotAt('2026-08-08T10:59:00.000Z');
    expect(snapshot.expectedState).toBe('open');
    expect(snapshot.currentCycleKey).toBe('2026-08-07');
  });

  test('08:00 fechado', () => {
    const snapshot = snapshotAt('2026-08-08T11:00:00.000Z');
    expect(snapshot.expectedState).toBe('closed');
    expect(snapshot.currentCycleKey).toBeNull();
  });

  test('12:00 fechado', () => {
    const snapshot = snapshotAt('2026-08-08T15:00:00.000Z');
    expect(snapshot.expectedState).toBe('closed');
  });

  test('calcula próxima abertura e fechamento', () => {
    const snapshot = snapshotAt('2026-08-08T15:00:00.000Z');
    expect(schedulerTimeService.formatInTimeZone(snapshot.nextOpenAtMs, 'America/Sao_Paulo')).toContain('19:00:00');
    expect(schedulerTimeService.formatInTimeZone(snapshot.nextCloseAtMs, 'America/Sao_Paulo')).toContain('08:00:00');
  });

  test('timezone inválido dispara erro', () => {
    expect(() =>
      schedulerTimeService.computeScheduleSnapshot({
        nowMs: Date.now(),
        openTime: '19:00',
        closeTime: '08:00',
        timeZone: 'America/Invalid_City',
      })
    ).toThrow(/QUEUE_TIMEZONE inválido/);
  });

  test('formato de horário inválido dispara erro', () => {
    expect(() =>
      schedulerTimeService.computeScheduleSnapshot({
        nowMs: Date.now(),
        openTime: '19',
        closeTime: '08:00',
        timeZone: 'America/Sao_Paulo',
      })
    ).toThrow(/QUEUE_OPEN_TIME inválido/);
  });
});
