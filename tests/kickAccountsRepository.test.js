const { createTestContext, getDb, countRows } = require('./helpers/testDatabase');

describe('kickAccountsRepository', () => {
  let context;
  let db;
  let kickAccountsRepository;

  beforeEach(async () => {
    context = await createTestContext();
    db = getDb(context.sqliteClient);
    kickAccountsRepository = require('../src/database/kickAccountsRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('cria a tabela kick_accounts durante initDatabase', () => {
    const row = db
      .prepare(
        `SELECT COUNT(1) AS count FROM sqlite_master WHERE type = 'table' AND name = 'kick_accounts'`,
      )
      .get();

    expect(row.count).toBe(1);
  });

  test('insere vínculo novo com upsert', () => {
    const saved = kickAccountsRepository.upsert({
      discordId: 'discord-1',
      kickUserId: 'kick-100',
      kickUsername: 'kick_user_100',
      linkedAtMs: 1000,
      updatedAtMs: 1000,
    });

    expect(saved).toEqual({
      discord_id: 'discord-1',
      kick_user_id: 'kick-100',
      kick_username: 'kick_user_100',
      linked_at_ms: 1000,
      updated_at_ms: 1000,
    });
    expect(countRows(db, 'kick_accounts')).toBe(1);
  });

  test('consulta por discord_id', () => {
    kickAccountsRepository.upsert({
      discordId: 'discord-2',
      kickUserId: 'kick-200',
      kickUsername: 'kick_user_200',
      linkedAtMs: 2000,
      updatedAtMs: 2000,
    });

    const found = kickAccountsRepository.findByDiscordId('discord-2');

    expect(found).not.toBeNull();
    expect(found.kick_user_id).toBe('kick-200');
  });

  test('consulta por kick_user_id', () => {
    kickAccountsRepository.upsert({
      discordId: 'discord-3',
      kickUserId: 'kick-300',
      kickUsername: 'kick_user_300',
      linkedAtMs: 3000,
      updatedAtMs: 3000,
    });

    const found = kickAccountsRepository.findByKickUserId('kick-300');

    expect(found).not.toBeNull();
    expect(found.discord_id).toBe('discord-3');
  });

  test('retorna null quando não encontra registro', () => {
    expect(kickAccountsRepository.findByDiscordId('missing-discord')).toBeNull();
    expect(kickAccountsRepository.findByKickUserId('missing-kick')).toBeNull();
  });

  test('atualiza kick_username sem duplicar quando discord_id já existe', () => {
    kickAccountsRepository.upsert({
      discordId: 'discord-4',
      kickUserId: 'kick-400',
      kickUsername: 'kick_user_old',
      linkedAtMs: 4000,
      updatedAtMs: 4000,
    });

    kickAccountsRepository.upsert({
      discordId: 'discord-4',
      kickUserId: 'kick-400',
      kickUsername: 'kick_user_new',
      updatedAtMs: 4500,
    });

    const found = kickAccountsRepository.findByDiscordId('discord-4');
    expect(found.kick_username).toBe('kick_user_new');
    expect(countRows(db, 'kick_accounts')).toBe(1);
  });

  test('preserva linked_at_ms durante atualização', () => {
    kickAccountsRepository.upsert({
      discordId: 'discord-5',
      kickUserId: 'kick-500',
      kickUsername: 'kick_user_500',
      linkedAtMs: 5000,
      updatedAtMs: 5000,
    });

    kickAccountsRepository.upsert({
      discordId: 'discord-5',
      kickUserId: 'kick-500',
      kickUsername: 'kick_user_500_new',
      linkedAtMs: 9999,
      updatedAtMs: 5500,
    });

    const found = kickAccountsRepository.findByDiscordId('discord-5');
    expect(found.linked_at_ms).toBe(5000);
  });

  test('atualiza updated_at_ms durante atualização', () => {
    kickAccountsRepository.upsert({
      discordId: 'discord-6',
      kickUserId: 'kick-600',
      kickUsername: 'kick_user_600',
      linkedAtMs: 6000,
      updatedAtMs: 6000,
    });

    kickAccountsRepository.upsert({
      discordId: 'discord-6',
      kickUserId: 'kick-600',
      kickUsername: 'kick_user_600_new',
      updatedAtMs: 6500,
    });

    const found = kickAccountsRepository.findByDiscordId('discord-6');
    expect(found.updated_at_ms).toBe(6500);
  });

  test('bloqueia vincular mesmo kick_user_id em dois discord_id', () => {
    kickAccountsRepository.upsert({
      discordId: 'discord-7A',
      kickUserId: 'kick-700',
      kickUsername: 'kick_user_700',
      linkedAtMs: 7000,
      updatedAtMs: 7000,
    });

    let caughtError = null;
    try {
      kickAccountsRepository.upsert({
        discordId: 'discord-7B',
        kickUserId: 'kick-700',
        kickUsername: 'kick_user_conflict',
        linkedAtMs: 7100,
        updatedAtMs: 7100,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeTruthy();
    expect(caughtError.code).toBe('KICK_ACCOUNT_CONFLICT');
    expect(caughtError.message).toMatch(/kick_user_id/);
    expect(countRows(db, 'kick_accounts')).toBe(1);
  });

  test('remove vínculo por discord_id', () => {
    kickAccountsRepository.upsert({
      discordId: 'discord-8',
      kickUserId: 'kick-800',
      kickUsername: 'kick_user_800',
      linkedAtMs: 8000,
      updatedAtMs: 8000,
    });

    const removed = kickAccountsRepository.deleteByDiscordId('discord-8');

    expect(removed).toBe(true);
    expect(kickAccountsRepository.findByDiscordId('discord-8')).toBeNull();
    expect(countRows(db, 'kick_accounts')).toBe(0);
  });

  test('remoção inexistente não derruba aplicação', () => {
    expect(() => kickAccountsRepository.deleteByDiscordId('discord-missing')).not.toThrow();
    expect(kickAccountsRepository.deleteByDiscordId('discord-missing')).toBe(false);
  });
});
