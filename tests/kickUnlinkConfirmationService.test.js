const service = require('../src/services/kickUnlinkConfirmationService');

describe('kickUnlinkConfirmationService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    service._resetForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
    service._resetForTests();
  });

  test('gera confirmação com expiração de 5 minutos', () => {
    const created = service.create('discord-1', { kickUsername: 'user1' });

    expect(created.token).toMatch(/^[a-f0-9]{32}$/);
    expect(created.expiresAtMs).toBe(Date.now() + 5 * 60 * 1000);
    expect(service.getTtlMs()).toBe(5 * 60 * 1000);
  });

  test('valida usuário correto e bloqueia usuário diferente', () => {
    const created = service.create('discord-owner');

    expect(service.validate(created.token, 'discord-owner')).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(service.validate(created.token, 'discord-other')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  test('consumo é de uso único', () => {
    const created = service.create('discord-2');

    expect(service.consume(created.token, 'discord-2')).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(service.consume(created.token, 'discord-2')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  test('expira após 5 minutos', () => {
    const created = service.create('discord-3');

    jest.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(service.validate(created.token, 'discord-3')).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  test('invalida confirmação explicitamente', () => {
    const created = service.create('discord-4');

    expect(service.invalidate(created.token)).toBe(true);
    expect(service.validate(created.token, 'discord-4')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
