function loadConfig(overrides = {}) {
  jest.resetModules();

  const env = {
    DISCORD_TOKEN: 'test-token',
    GUILD_ID: 'test-guild',
    ...overrides,
  };

  for (const key of Object.keys(process.env)) {
    if (
      key === 'PORT' ||
      key === 'KICK_PORT' ||
      key === 'KICK_HOST' ||
      key === 'DATABASE_PATH' ||
      key === 'SQLITE_BACKUP_DIRECTORY' ||
      key === 'ADMIN_AUDIT_RETENTION_DAYS' ||
      key === 'BOT_OPERATOR_ROLE_IDS' ||
      key === 'DISCORD_TOKEN' ||
      key === 'GUILD_ID'
    ) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, env);
  return require('../src/config');
}

describe('config Railway host/port and data paths', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  test('PORT tem precedência sobre KICK_PORT', () => {
    const config = loadConfig({ PORT: '4567', KICK_PORT: '3001' });
    expect(config.kickPort).toBe(4567);
  });

  test('KICK_PORT é usada quando PORT não existe', () => {
    const config = loadConfig({ KICK_PORT: '3010' });
    expect(config.kickPort).toBe(3010);
  });

  test('fallback de porta para 3000', () => {
    const config = loadConfig({ KICK_PORT: 'invalid' });
    expect(config.kickPort).toBe(3000);
  });

  test('host é configurável com KICK_HOST', () => {
    const config = loadConfig({ KICK_HOST: '0.0.0.0' });
    expect(config.kickHost).toBe('0.0.0.0');
  });

  test('host local padrão é 127.0.0.1', () => {
    const config = loadConfig({});
    expect(config.kickHost).toBe('127.0.0.1');
  });

  test('caminhos /data são respeitados quando configurados', () => {
    const config = loadConfig({
      DATABASE_PATH: '/data/database.sqlite',
      SQLITE_BACKUP_DIRECTORY: '/data/backups',
    });

    expect(config.databasePath).toBe('/data/database.sqlite');
    expect(config.sqliteBackupDirectory).toBe('/data/backups');
  });

  test('retenção de auditoria administrativa usa padrão de 30 dias', () => {
    const config = loadConfig({});
    expect(config.adminAuditRetentionDays).toBe(30);
  });

  test('retenção de auditoria administrativa aceita valor válido', () => {
    const config = loadConfig({ ADMIN_AUDIT_RETENTION_DAYS: '3650' });
    expect(config.adminAuditRetentionDays).toBe(3650);
  });

  test('BOT_OPERATOR_ROLE_IDS ausente não bloqueia startup', () => {
    const config = loadConfig({});
    expect(config.botOperatorRoleIds).toEqual([]);
  });

  test('BOT_OPERATOR_ROLE_IDS vazia resulta em lista vazia', () => {
    const config = loadConfig({ BOT_OPERATOR_ROLE_IDS: '' });
    expect(config.botOperatorRoleIds).toEqual([]);
  });

  test('BOT_OPERATOR_ROLE_IDS com apenas espaços e vírgulas resulta em lista vazia', () => {
    const config = loadConfig({ BOT_OPERATOR_ROLE_IDS: ' ,   , ' });
    expect(config.botOperatorRoleIds).toEqual([]);
  });

  test('BOT_OPERATOR_ROLE_IDS remove espaços, ignora vazios e deduplica', () => {
    const config = loadConfig({
      BOT_OPERATOR_ROLE_IDS: ' 123456789012345678 , , 234567890123456789,123456789012345678 ',
    });

    expect(config.botOperatorRoleIds).toEqual([
      '123456789012345678',
      '234567890123456789',
    ]);
  });

  test.each([
    ['abc'],
    ['123'],
    ['123456789012345678,invalid'],
  ])('BOT_OPERATOR_ROLE_IDS inválido (%s) falha startup de configuração', (value) => {
    expect(() => loadConfig({ BOT_OPERATOR_ROLE_IDS: value })).toThrow('BOT_OPERATOR_ROLE_IDS inválido.');
  });

  test.each([
    ['0'],
    ['-1'],
    ['30.5'],
    ['abc'],
    ['3651'],
  ])('retenção de auditoria administrativa inválida (%s) falha startup de configuração', (value) => {
    expect(() => loadConfig({ ADMIN_AUDIT_RETENTION_DAYS: value })).toThrow('ADMIN_AUDIT_RETENTION_DAYS inválido.');
  });
});
