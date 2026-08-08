process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'guild-1';

const { createAppBootstrapService } = require('../src/services/appBootstrapService');

describe('appBootstrapService', () => {
  test('falha parcial no bootstrap executa cleanup', async () => {
    const initDatabase = jest.fn().mockResolvedValue(undefined);
    const startKickHttpServer = jest.fn().mockResolvedValue({ started: true, port: 3000 });
    const shutdown = jest.fn().mockResolvedValue({ exitCode: 1 });
    const login = jest.fn().mockRejectedValue(new Error('discord login failed'));

    const service = createAppBootstrapService({
      config: {
        databasePath: './data/database.sqlite',
        discordToken: 'token',
      },
      database: { initDatabase },
      startKickHttpServer,
      gracefulShutdownService: { shutdown },
      logger: { info: jest.fn(), error: jest.fn() },
    });

    const result = await service.start({ login });

    expect(result.started).toBe(false);
    expect(initDatabase).toHaveBeenCalledTimes(1);
    expect(startKickHttpServer).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'startup_failure',
        fatal: true,
      }),
    );
  });
});
