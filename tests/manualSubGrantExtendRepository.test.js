const { createTestContext, getDb } = require('./helpers/testDatabase');

describe('manualSubGrantService.extendGrant (SQLite real)', () => {
  let context;
  let db;
  let service;
  let repository;

  const NOW_MS = 1_725_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    context = await createTestContext({ nodeEnv: 'test' });
    db = getDb(context.sqliteClient);
    service = require('../src/services/manualSubGrantService');
    repository = require('../src/database/manualSubGrantsRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  function createGrant({
    discordId = 'user-1',
    grantedByDiscordId = 'admin-1',
    reason = 'Pix',
    grantedAtMs = NOW_MS - 10 * DAY_MS,
    expiresAtMs = NOW_MS + 10 * DAY_MS,
  } = {}) {
    return repository.createGrant({
      discordId,
      grantedByDiscordId,
      reason,
      grantedAtMs,
      expiresAtMs,
    });
  }

  test('ativa + 20 dias soma ao vencimento atual', () => {
    const current = createGrant({ expiresAtMs: NOW_MS + 5 * DAY_MS });

    const result = service.extendGrant({
      discordId: current.discord_id,
      extendedByDiscordId: 'admin-2',
      reason: 'Renovacao',
      days: 20,
      nowMs: NOW_MS,
    });

    expect(result.extended).toBe(true);
    expect(result.statusBefore).toBe('active');
    expect(result.previousExpiresAtMs).toBe(NOW_MS + 5 * DAY_MS);
    expect(result.newExpiresAtMs).toBe(NOW_MS + 25 * DAY_MS);
  });

  test('ativa com 15 dias restantes +20 resulta em 35 dias restantes', () => {
    createGrant({ discordId: 'user-2', expiresAtMs: NOW_MS + 15 * DAY_MS });

    const result = service.extendGrant({
      discordId: 'user-2',
      extendedByDiscordId: 'admin-2',
      reason: 'PIX confirmado',
      days: 20,
      nowMs: NOW_MS,
    });

    expect(result.newExpiresAtMs - NOW_MS).toBe(35 * DAY_MS);
  });

  test('expirada + 20 começa em agora', () => {
    createGrant({ discordId: 'user-3', expiresAtMs: NOW_MS - 2 * DAY_MS });

    const result = service.extendGrant({
      discordId: 'user-3',
      extendedByDiscordId: 'admin-3',
      reason: 'Reativacao',
      days: 20,
      nowMs: NOW_MS,
    });

    expect(result.extended).toBe(true);
    expect(result.statusBefore).toBe('expired');
    expect(result.previousExpiresAtMs).toBe(NOW_MS - 2 * DAY_MS);
    expect(result.newExpiresAtMs).toBe(NOW_MS + 20 * DAY_MS);
  });

  test('duas extensões válidas acumulam', () => {
    createGrant({ discordId: 'user-4', expiresAtMs: NOW_MS + 10 * DAY_MS });

    const first = service.extendGrant({
      discordId: 'user-4',
      extendedByDiscordId: 'admin-a',
      reason: 'Ext1',
      days: 15,
      nowMs: NOW_MS,
    });

    const second = service.extendGrant({
      discordId: 'user-4',
      extendedByDiscordId: 'admin-b',
      reason: 'Ext2',
      days: 20,
      nowMs: NOW_MS,
    });

    expect(first.newExpiresAtMs).toBe(NOW_MS + 25 * DAY_MS);
    expect(second.newExpiresAtMs).toBe(NOW_MS + 45 * DAY_MS);
  });

  test('inexistente não cria concessão', () => {
    const before = db.prepare('SELECT COUNT(1) AS count FROM manual_sub_grants').get().count;

    const result = service.extendGrant({
      discordId: 'never-seen',
      extendedByDiscordId: 'admin-4',
      reason: 'Tentativa',
      days: 20,
      nowMs: NOW_MS,
    });

    const after = db.prepare('SELECT COUNT(1) AS count FROM manual_sub_grants').get().count;

    expect(result).toEqual({
      extended: false,
      reason: 'not_found',
      grant: null,
    });
    expect(after).toBe(before);
  });

  test('revogada não é reativada', () => {
    createGrant({ discordId: 'user-5', expiresAtMs: NOW_MS + 10 * DAY_MS });
    repository.revokeActiveByDiscordId({
      discordId: 'user-5',
      revokedByDiscordId: 'admin-revoker',
      revokeReason: 'Encerrado',
      revokedAtMs: NOW_MS - DAY_MS,
    });

    const result = service.extendGrant({
      discordId: 'user-5',
      extendedByDiscordId: 'admin-5',
      reason: 'Nao deve reativar',
      days: 20,
      nowMs: NOW_MS,
    });

    const row = db.prepare('SELECT revoked_at_ms, revoked_by_discord_id, revoke_reason FROM manual_sub_grants WHERE discord_id = ?').get('user-5');

    expect(result.extended).toBe(false);
    expect(result.reason).toBe('revoked');
    expect(row.revoked_at_ms).toBe(NOW_MS - DAY_MS);
    expect(row.revoked_by_discord_id).toBe('admin-revoker');
    expect(row.revoke_reason).toBe('Encerrado');
  });

  test('quando a mais recente está revogada, não estende concessão antiga ainda ativa', () => {
    db.prepare(
      `INSERT INTO manual_sub_grants (
        discord_id,
        granted_by_discord_id,
        reason,
        granted_at_ms,
        expires_at_ms,
        revoked_at_ms,
        revoked_by_discord_id,
        revoke_reason
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run('user-5b', 'admin-old', 'Antiga ativa', NOW_MS - 40 * DAY_MS, NOW_MS + 30 * DAY_MS);

    db.prepare(
      `INSERT INTO manual_sub_grants (
        discord_id,
        granted_by_discord_id,
        reason,
        granted_at_ms,
        expires_at_ms,
        revoked_at_ms,
        revoked_by_discord_id,
        revoke_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'user-5b',
      'admin-new',
      'Mais recente revogada',
      NOW_MS - 20 * DAY_MS,
      NOW_MS + 10 * DAY_MS,
      NOW_MS - 5 * DAY_MS,
      'admin-revoker',
      'Revogada explicitamente',
    );

    const olderBefore = db
      .prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ? ORDER BY granted_at_ms ASC, id ASC LIMIT 1')
      .get('user-5b');

    const result = service.extendGrant({
      discordId: 'user-5b',
      extendedByDiscordId: 'admin-5b',
      reason: 'Nao pode estender antiga',
      days: 20,
      nowMs: NOW_MS,
    });

    const olderAfter = db
      .prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ? ORDER BY granted_at_ms ASC, id ASC LIMIT 1')
      .get('user-5b');
    const latest = db
      .prepare('SELECT revoked_at_ms, revoke_reason FROM manual_sub_grants WHERE discord_id = ? ORDER BY granted_at_ms DESC, id DESC LIMIT 1')
      .get('user-5b');

    expect(result.extended).toBe(false);
    expect(result.reason).toBe('revoked');
    expect(olderAfter.expires_at_ms).toBe(olderBefore.expires_at_ms);
    expect(latest.revoked_at_ms).toBe(NOW_MS - 5 * DAY_MS);
    expect(latest.revoke_reason).toBe('Revogada explicitamente');
  });

  test('concessão sem vencimento não vira temporária', () => {
    createGrant({ discordId: 'user-6', expiresAtMs: null });

    const result = service.extendGrant({
      discordId: 'user-6',
      extendedByDiscordId: 'admin-6',
      reason: 'Nao aplica',
      days: 20,
      nowMs: NOW_MS,
    });

    const row = db.prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ?').get('user-6');

    expect(result.extended).toBe(false);
    expect(result.reason).toBe('not_extendable');
    expect(row.expires_at_ms).toBeNull();
  });

  test('falha após UPDATE faz rollback integral', () => {
    createGrant({ discordId: 'user-7', expiresAtMs: NOW_MS + 10 * DAY_MS });

    db.exec(`
      CREATE TRIGGER trg_manual_sub_grants_extend_fail
      AFTER UPDATE OF expires_at_ms ON manual_sub_grants
      WHEN NEW.discord_id = 'user-7'
      BEGIN
        SELECT RAISE(FAIL, 'forced trigger failure');
      END;
    `);

    expect(() => {
      service.extendGrant({
        discordId: 'user-7',
        extendedByDiscordId: 'admin-7',
        reason: 'Teste rollback',
        days: 20,
        nowMs: NOW_MS,
      });
    }).toThrow('forced trigger failure');

    const row = db.prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ?').get('user-7');
    expect(row.expires_at_ms).toBe(NOW_MS + 10 * DAY_MS);
  });

  test('atualização afeta exatamente um registro e preserva dados originais', () => {
    const grant = createGrant({
      discordId: 'user-8',
      grantedByDiscordId: 'admin-original',
      reason: 'Motivo original',
      grantedAtMs: NOW_MS - 30 * DAY_MS,
      expiresAtMs: NOW_MS + 2 * DAY_MS,
    });

    const beforeCount = db.prepare('SELECT COUNT(1) AS count FROM manual_sub_grants WHERE discord_id = ?').get('user-8').count;

    const result = service.extendGrant({
      discordId: 'user-8',
      extendedByDiscordId: 'admin-8',
      reason: 'Extensao validada',
      days: 20,
      nowMs: NOW_MS,
    });

    const afterCount = db.prepare('SELECT COUNT(1) AS count FROM manual_sub_grants WHERE discord_id = ?').get('user-8').count;
    const row = db
      .prepare(
        'SELECT id, granted_by_discord_id, reason, granted_at_ms, revoked_at_ms, revoked_by_discord_id, revoke_reason, expires_at_ms FROM manual_sub_grants WHERE discord_id = ?',
      )
      .get('user-8');

    expect(result.extended).toBe(true);
    expect(beforeCount).toBe(1);
    expect(afterCount).toBe(1);
    expect(row.id).toBe(grant.id);
    expect(row.granted_by_discord_id).toBe('admin-original');
    expect(row.reason).toBe('Motivo original');
    expect(row.granted_at_ms).toBe(NOW_MS - 30 * DAY_MS);
    expect(row.revoked_at_ms).toBeNull();
    expect(row.revoked_by_discord_id).toBeNull();
    expect(row.revoke_reason).toBeNull();
    expect(row.expires_at_ms).toBe(NOW_MS + 22 * DAY_MS);
  });

  test('vínculo e assinatura Kick não são modificados', () => {
    createGrant({ discordId: 'user-9', expiresAtMs: NOW_MS + 3 * DAY_MS });

    db.prepare(
      `INSERT INTO kick_accounts (discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('user-9', 'kick-9', 'nick9', NOW_MS - 50_000, NOW_MS - 50_000);

    db.prepare(
      `INSERT INTO kick_subscriptions (
        broadcaster_user_id, kick_user_id, kick_username, subscription_type, started_at_ms, expires_at_ms, last_event_message_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('broadcaster-1', 'kick-9', 'nick9', 'gifted', NOW_MS - 10_000, NOW_MS + 99 * DAY_MS, 'evt-9', NOW_MS - 10_000);

    service.extendGrant({
      discordId: 'user-9',
      extendedByDiscordId: 'admin-9',
      reason: 'Renovacao',
      days: 20,
      nowMs: NOW_MS,
    });

    const account = db.prepare('SELECT * FROM kick_accounts WHERE discord_id = ?').get('user-9');
    const sub = db
      .prepare('SELECT * FROM kick_subscriptions WHERE broadcaster_user_id = ? AND kick_user_id = ?')
      .get('broadcaster-1', 'kick-9');

    expect(account.kick_username).toBe('nick9');
    expect(sub.subscription_type).toBe('gifted');
    expect(sub.expires_at_ms).toBe(NOW_MS + 99 * DAY_MS);
  });
});
