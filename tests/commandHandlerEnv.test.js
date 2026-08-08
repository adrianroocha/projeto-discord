describe('command handler environment registration', () => {
  function loadWithEnv(nodeEnv) {
    jest.resetModules();
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.GUILD_ID = 'test-guild';
    process.env.NODE_ENV = nodeEnv;

    const commandHandler = require('../src/handlers/commandHandler');
    const client = {};
    commandHandler.loadCommands(client, { nodeEnv });
    return client;
  }

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.DISCORD_TOKEN;
    delete process.env.GUILD_ID;
  });

  test('registra fila-add-teste em development', () => {
    const client = loadWithEnv('development');
    expect(client.commands.has('fila-add-teste')).toBe(true);
    expect(client.commands.has('dev-fill-queue')).toBe(true);
    expect(client.commands.has('dev-clear-test-data')).toBe(true);
  });

  test('não registra fila-add-teste em production', () => {
    const client = loadWithEnv('production');
    expect(client.commands.has('fila-add-teste')).toBe(false);
    expect(client.commands.has('dev-fill-queue')).toBe(false);
    expect(client.commands.has('dev-clear-test-data')).toBe(false);
  });
});
