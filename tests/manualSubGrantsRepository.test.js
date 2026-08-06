const { createTestContext, getDb } = require('./helpers/testDatabase');

describe('manualSubGrantsRepository', () => {
  let context;
  let db;
  let repository;

  beforeEach(async () => {
    context = await createTestContext();
    db = getDb(context.sqliteClient);
    repository = require('../src/database/manualSubGrantsRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('cria a tabela manual_sub_grants durante initDatabase', () => {
    const row = db
      .prepare(
        `SELECT COUNT(1) AS count FROM sqlite_master WHERE type = 'table' AND name = 'manual_sub_grants'`,
      )
      .get();

    expect(row.count).toBe(1);
  });

  test('cria concessão permanente', () => {
    const grant = repository.createGrant({
      discordId: 'discord-1',
      grantedByDiscordId: 'admin-1',
      reason: 'Cortesia',
      grantedAtMs: 1000,
      expiresAtMs: null,
    });

    expect(grant.discord_id).toBe('discord-1');
    expect(grant.expires_at_ms).toBeNull();
    expect(grant.revoked_at_ms).toBeNull();
  });

  test('cria concessão temporária', () => {
    const grant = repository.createGrant({
      discordId: 'discord-2',
      grantedByDiscordId: 'admin-2',
      reason: 'Pix',
      grantedAtMs: 2000,
      expiresAtMs: 5000,
    });

    expect(grant.expires_at_ms).toBe(5000);
  });

  test('findActiveByDiscordId retorna concessão ativa', () => {
    repository.createGrant({
      discordId: 'discord-3',
      grantedByDiscordId: 'admin-3',
      reason: 'Patrocinador',
      grantedAtMs: 3000,
      expiresAtMs: 9000,
    });

    const active = repository.findActiveByDiscordId('discord-3', 4000);
    expect(active).not.toBeNull();
    expect(active.reason).toBe('Patrocinador');
  });

  test('findActiveByDiscordId não retorna concessão expirada', () => {
    repository.createGrant({
      discordId: 'discord-4',
      grantedByDiscordId: 'admin-4',
      reason: 'Convidado',
      grantedAtMs: 1000,
      expiresAtMs: 2000,
    });

    const active = repository.findActiveByDiscordId('discord-4', 2000);
    expect(active).toBeNull();
  });

  test('bloqueia concessão duplicada ativa', () => {
    repository.createGrant({
      discordId: 'discord-5',
      grantedByDiscordId: 'admin-5',
      reason: 'Cortesia A',
      grantedAtMs: 1000,
      expiresAtMs: null,
    });

    expect(() => {
      repository.createGrant({
        discordId: 'discord-5',
        grantedByDiscordId: 'admin-5',
        reason: 'Cortesia B',
        grantedAtMs: 1200,
        expiresAtMs: null,
      });
    }).toThrow(/Concessão manual ativa já existe/);
  });

  test('permite nova concessão após expiração', () => {
    repository.createGrant({
      discordId: 'discord-6',
      grantedByDiscordId: 'admin-6',
      reason: 'Expira rápido',
      grantedAtMs: 1000,
      expiresAtMs: 1200,
    });

    const second = repository.createGrant({
      discordId: 'discord-6',
      grantedByDiscordId: 'admin-6',
      reason: 'Nova concessão',
      grantedAtMs: 1300,
      expiresAtMs: null,
    });

    expect(second.reason).toBe('Nova concessão');
  });

  test('revoga concessão ativa e mantém histórico', () => {
    repository.createGrant({
      discordId: 'discord-7',
      grantedByDiscordId: 'admin-7',
      reason: 'Benefício',
      grantedAtMs: 1000,
      expiresAtMs: null,
    });

    const revoked = repository.revokeActiveByDiscordId({
      discordId: 'discord-7',
      revokedByDiscordId: 'admin-8',
      revokeReason: 'Fim da cortesia',
      revokedAtMs: 1500,
    });

    expect(revoked.revoked).toBe(true);
    expect(revoked.grant.revoked_at_ms).toBe(1500);
    expect(revoked.grant.revoked_by_discord_id).toBe('admin-8');

    const history = repository.findHistoryByDiscordId('discord-7');
    expect(history).toHaveLength(1);
    expect(history[0].revoke_reason).toBe('Fim da cortesia');
  });

  test('revogação inexistente retorna not_found', () => {
    const revoked = repository.revokeActiveByDiscordId({
      discordId: 'discord-8',
      revokedByDiscordId: 'admin-9',
      revokeReason: 'Sem vínculo',
      revokedAtMs: 2000,
    });

    expect(revoked).toEqual({ revoked: false, reason: 'not_found' });
  });

  test('hasActiveGrant retorna verdadeiro e falso corretamente', () => {
    repository.createGrant({
      discordId: 'discord-9',
      grantedByDiscordId: 'admin-9',
      reason: 'Temporário',
      grantedAtMs: 1000,
      expiresAtMs: 3000,
    });

    expect(repository.hasActiveGrant('discord-9', 2000)).toBe(true);
    expect(repository.hasActiveGrant('discord-9', 3000)).toBe(false);
  });
});
