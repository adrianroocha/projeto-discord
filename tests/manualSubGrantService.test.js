jest.mock('../src/database/manualSubGrantsRepository', () => ({
  createGrant: jest.fn(),
  findActiveByDiscordId: jest.fn(),
  findHistoryByDiscordId: jest.fn(),
  revokeActiveByDiscordId: jest.fn(),
  hasActiveGrant: jest.fn(),
}));

const repository = require('../src/database/manualSubGrantsRepository');
const service = require('../src/services/manualSubGrantService');

describe('manualSubGrantService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('calcula expires_at_ms corretamente para concessão temporária', () => {
    repository.createGrant.mockReturnValue({
      id: 1,
      discord_id: 'discord-1',
      granted_by_discord_id: 'admin-1',
      reason: 'Pix',
      granted_at_ms: 1_000,
      expires_at_ms: 1_000 + 10 * service.constants.DAY_MS,
      revoked_at_ms: null,
      revoked_by_discord_id: null,
      revoke_reason: null,
    });

    const result = service.createGrant({
      discordId: 'discord-1',
      grantedByDiscordId: 'admin-1',
      reason: 'Pix',
      days: 10,
      nowMs: 1_000,
    });

    expect(result.created).toBe(true);
    expect(repository.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAtMs: 1_000 + 10 * service.constants.DAY_MS,
      }),
    );
  });

  test('rejeita duração zero', () => {
    expect(() => {
      service.createGrant({
        discordId: 'discord-2',
        grantedByDiscordId: 'admin-2',
        reason: 'Cortesia',
        days: 0,
        nowMs: 1_000,
      });
    }).toThrow(/dias deve estar entre 1 e 365/);
  });

  test('rejeita duração negativa', () => {
    expect(() => {
      service.createGrant({
        discordId: 'discord-3',
        grantedByDiscordId: 'admin-3',
        reason: 'Cortesia',
        days: -10,
        nowMs: 1_000,
      });
    }).toThrow(/dias deve estar entre 1 e 365/);
  });

  test('rejeita duração acima de 365 dias', () => {
    expect(() => {
      service.createGrant({
        discordId: 'discord-4',
        grantedByDiscordId: 'admin-4',
        reason: 'Patrocinador',
        days: 366,
        nowMs: 1_000,
      });
    }).toThrow(/dias deve estar entre 1 e 365/);
  });

  test('rejeita motivo vazio após trim', () => {
    expect(() => {
      service.createGrant({
        discordId: 'discord-5',
        grantedByDiscordId: 'admin-5',
        reason: '   ',
        nowMs: 1_000,
      });
    }).toThrow(/motivo é obrigatório/);
  });

  test('retorna active_exists quando repositório bloqueia duplicidade ativa', () => {
    const err = new Error('duplicate');
    err.code = 'MANUAL_SUB_GRANT_ACTIVE_EXISTS';
    repository.createGrant.mockImplementation(() => {
      throw err;
    });

    const result = service.createGrant({
      discordId: 'discord-6',
      grantedByDiscordId: 'admin-6',
      reason: 'Pix',
      nowMs: 1_000,
    });

    expect(result).toEqual({ created: false, reason: 'active_exists' });
  });

  test('hasActiveGrant retorna verdadeiro e falso', () => {
    repository.hasActiveGrant.mockReturnValueOnce(true).mockReturnValueOnce(false);

    expect(service.hasActiveGrant('discord-7', 2_000)).toBe(true);
    expect(service.hasActiveGrant('discord-7', 3_000)).toBe(false);
  });

  test('revogação inexistente retorna not_found', () => {
    repository.revokeActiveByDiscordId.mockReturnValue({ revoked: false, reason: 'not_found' });

    const result = service.revokeGrant({
      discordId: 'discord-8',
      revokedByDiscordId: 'admin-8',
      reason: 'Encerrado',
      nowMs: 2_000,
    });

    expect(result).toEqual({ revoked: false, reason: 'not_found' });
  });
});
