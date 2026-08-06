const { createTestContext, getDb } = require('./helpers/testDatabase');

describe('kick unlink audit transactional flow', () => {
  let context;
  let db;
  let kickAccountsRepository;
  let kickUnlinkAuditRepository;

  beforeEach(async () => {
    context = await createTestContext({ kickBroadcasterUserId: 'b-1' });
    db = getDb(context.sqliteClient);
    kickAccountsRepository = require('../src/database/kickAccountsRepository');
    kickUnlinkAuditRepository = require('../src/database/kickUnlinkAuditRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('remove vínculo e registra auditoria', () => {
    db.prepare(
      'INSERT INTO kick_accounts (discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run('discord-1', 'kick-1', 'kickUser1', 1000, 1000);

    const result = kickAccountsRepository.unlinkWithAudit({
      discordId: 'discord-1',
      unlinkedByDiscordId: 'admin-1',
      reason: 'Solicitação do usuário',
      unlinkedAtMs: 2000,
    });

    expect(result.unlinked).toBe(true);
    expect(kickAccountsRepository.findByDiscordId('discord-1')).toBeNull();

    const audit = kickUnlinkAuditRepository.findLatest();
    expect(audit).toMatchObject({
      discord_id: 'discord-1',
      kick_user_id: 'kick-1',
      kick_username: 'kickUser1',
      unlinked_by_discord_id: 'admin-1',
      reason: 'Solicitação do usuário',
    });
  });

  test('transação atômica preserva vínculo quando auditoria falha', () => {
    db.prepare(
      'INSERT INTO kick_accounts (discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run('discord-2', 'kick-2', 'kickUser2', 1000, 1000);

    const registerSpy = jest
      .spyOn(kickUnlinkAuditRepository, 'register')
      .mockImplementation(() => {
        throw new Error('falha-auditoria');
      });

    expect(() => {
      kickAccountsRepository.unlinkWithAudit({
        discordId: 'discord-2',
        unlinkedByDiscordId: 'admin-2',
        reason: 'Erro simulado',
        unlinkedAtMs: 3000,
      });
    }).toThrow('falha-auditoria');

    const linkAfter = kickAccountsRepository.findByDiscordId('discord-2');
    expect(linkAfter).not.toBeNull();
    expect(linkAfter.kick_username).toBe('kickUser2');

    expect(kickUnlinkAuditRepository.countAll()).toBe(0);
    registerSpy.mockRestore();
  });

  test('concessão manual e subscription Kick são preservadas', () => {
    db.prepare(
      'INSERT INTO kick_accounts (discord_id, kick_user_id, kick_username, linked_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run('discord-3', 'kick-3', 'kickUser3', 1000, 1000);

    db.prepare(
      `INSERT INTO manual_sub_grants (
        discord_id, granted_by_discord_id, reason, granted_at_ms, expires_at_ms,
        revoked_at_ms, revoked_by_discord_id, revoke_reason
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run('discord-3', 'admin-3', 'Pix', 1500, null);

    db.prepare(
      `INSERT INTO kick_subscriptions (
        broadcaster_user_id, kick_user_id, kick_username, subscription_type,
        started_at_ms, expires_at_ms, last_event_message_id, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('b-1', 'kick-3', 'kickUser3', 'direct', 1200, 9999999, 'event-1', 1200);

    const queueBefore = db.prepare('SELECT COUNT(1) AS count FROM queue_entries').get().count;

    kickAccountsRepository.unlinkWithAudit({
      discordId: 'discord-3',
      unlinkedByDiscordId: 'admin-3',
      reason: 'Administração',
      unlinkedAtMs: 4000,
    });

    const manualCount = db.prepare('SELECT COUNT(1) AS count FROM manual_sub_grants WHERE discord_id = ?').get('discord-3').count;
    const subscriptionCount = db
      .prepare('SELECT COUNT(1) AS count FROM kick_subscriptions WHERE broadcaster_user_id = ? AND kick_user_id = ?')
      .get('b-1', 'kick-3').count;
    const queueAfter = db.prepare('SELECT COUNT(1) AS count FROM queue_entries').get().count;

    expect(manualCount).toBe(1);
    expect(subscriptionCount).toBe(1);
    expect(queueAfter).toBe(queueBefore);
  });
});
