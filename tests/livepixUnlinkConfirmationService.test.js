const confirmationService = require('../src/services/livepixUnlinkConfirmationService');

describe('livepixUnlinkConfirmationService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    confirmationService._resetForTests();
  });

  afterEach(() => {
    confirmationService._resetForTests();
    jest.useRealTimers();
  });

  test('confirmação é de uso único e vinculada ao Discord iniciador', () => {
    const { token } = confirmationService.create('discord-owner');

    expect(confirmationService.consume(token, 'discord-other')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(confirmationService.consume(token, 'discord-owner')).toEqual({ ok: true });
    expect(confirmationService.consume(token, 'discord-owner')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  test('confirmação expira em cinco minutos e somente o iniciador pode cancelar', () => {
    const { token } = confirmationService.create('discord-owner');

    expect(confirmationService.invalidate(token, 'discord-other')).toBe(false);
    jest.advanceTimersByTime(confirmationService.TTL_MS);
    expect(confirmationService.consume(token, 'discord-owner')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
