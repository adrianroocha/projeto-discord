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
  afterEach(() => {
    delete process.env.PORT;
    delete process.env.KICK_PORT;
    delete process.env.KICK_HOST;
    delete process.env.DATABASE_PATH;
    delete process.env.SQLITE_BACKUP_DIRECTORY;
    delete process.env.DISCORD_TOKEN;
    delete process.env.GUILD_ID;
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
});
