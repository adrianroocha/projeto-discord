const { createTestContext, getDb, countRows } = require('./helpers/testDatabase');

describe('livepixAccountsRepository', () => {
  let context;
  let db;
  let repository;
  let kickRepository;
  let livepixUnlinkAuditRepository;

  beforeEach(async () => {
    context = await createTestContext();
    db = getDb(context.sqliteClient);
    repository = require('../src/database/livepixAccountsRepository');
    kickRepository = require('../src/database/kickAccountsRepository');
    livepixUnlinkAuditRepository = require('../src/database/livepixUnlinkAuditRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('cria tabela exclusiva com IDs únicos e timestamps', () => {
    const columns = db.prepare('PRAGMA table_info(livepix_accounts)').all();
    expect(columns.map((column) => column.name)).toEqual([
      'discord_id',
      'livepix_account_id',
      'created_at_ms',
      'updated_at_ms',
    ]);
  });

  test('cria vínculo LivePix sem campos de token', () => {
    const saved = repository.createLink({
      discordId: 'discord-1',
      livepixAccountId: 'livepix-account-1',
      createdAtMs: 100,
      updatedAtMs: 101,
    });

    expect(saved).toEqual({
      discord_id: 'discord-1',
      livepix_account_id: 'livepix-account-1',
      created_at_ms: 100,
      updated_at_ms: 101,
    });
    expect(countRows(db, 'livepix_accounts')).toBe(1);
  });

  test('impede segundo vínculo do mesmo Discord sem substituir o primeiro', () => {
    repository.createLink({ discordId: 'discord-2', livepixAccountId: 'account-a' });

    expect(() => repository.createLink({ discordId: 'discord-2', livepixAccountId: 'account-b' })).toThrow(
      expect.objectContaining({ code: 'LIVEPIX_ACCOUNT_CONFLICT', reason: 'discord_already_linked' }),
    );
    expect(repository.findByDiscordId('discord-2').livepix_account_id).toBe('account-a');
    expect(countRows(db, 'livepix_accounts')).toBe(1);
  });

  test('impede conta LivePix duplicada sem revelar o Discord já vinculado', () => {
    repository.createLink({ discordId: 'private-discord-id', livepixAccountId: 'account-shared' });

    let caughtError;
    try {
      repository.createLink({ discordId: 'discord-other', livepixAccountId: 'account-shared' });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toMatchObject({
      code: 'LIVEPIX_ACCOUNT_CONFLICT',
      reason: 'account_already_linked',
    });
    expect(caughtError.message).not.toContain('private-discord-id');
    expect(countRows(db, 'livepix_accounts')).toBe(1);
  });

  test('desvinculação administrativa remove somente LivePix e grava auditoria', () => {
    repository.createLink({ discordId: 'discord-admin-unlink', livepixAccountId: 'livepix-77' });
    kickRepository.upsert({
      discordId: 'discord-admin-unlink',
      kickUserId: 'kick-77',
      kickUsername: 'kick-user-77',
    });

    const result = repository.unlinkWithAudit({
      discordId: 'discord-admin-unlink',
      unlinkedByDiscordId: 'admin-1',
      reason: 'Solicitação administrativa',
      unlinkedAtMs: 2000,
    });

    expect(result.unlinked).toBe(true);
    expect(repository.findByDiscordId('discord-admin-unlink')).toBeNull();
    expect(kickRepository.findByDiscordId('discord-admin-unlink').kick_user_id).toBe('kick-77');
    expect(livepixUnlinkAuditRepository.findLatest()).toMatchObject({
      discord_id: 'discord-admin-unlink',
      livepix_account_id: 'livepix-77',
      unlinked_by_discord_id: 'admin-1',
      unlinked_at_ms: 2000,
      reason: 'Solicitação administrativa',
    });
  });

  test('falha ao gravar auditoria mantém o vínculo LivePix', () => {
    repository.createLink({ discordId: 'discord-audit-failure', livepixAccountId: 'livepix-88' });
    const registerSpy = jest.spyOn(livepixUnlinkAuditRepository, 'register').mockImplementation(() => {
      throw new Error('falha-auditoria');
    });

    expect(() =>
      repository.unlinkWithAudit({
        discordId: 'discord-audit-failure',
        unlinkedByDiscordId: 'admin-2',
        reason: 'Teste',
        unlinkedAtMs: 3000,
      }),
    ).toThrow('falha-auditoria');
    expect(repository.findByDiscordId('discord-audit-failure').livepix_account_id).toBe('livepix-88');

    registerSpy.mockRestore();
  });
});
