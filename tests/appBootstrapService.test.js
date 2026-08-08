process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'guild-1';

const { createAppBootstrapService } = require('../src/services/appBootstrapService');

describe('appBootstrapService', () => {
  test('falha parcial no bootstrap executa cleanup', async () => {
    const initDatabase = jest.fn().mockResolvedValue(undefined);
    const startKickHttpServer = jest.fn().mockResolvedValue({ started: true, host: '127.0.0.1', port: 3000 });
    const shutdown = jest.fn().mockResolvedValue({ exitCode: 1 });
    const login = jest.fn().mockRejectedValue(new Error('discord login failed'));
    const lifecycleService = {
      markReady: jest.fn(),
      markFailed: jest.fn(),
    };

    const service = createAppBootstrapService({
      config: {
        databasePath: './data/database.sqlite',
        discordToken: 'token',
      },
      database: { initDatabase },
      commandHandler: { registerCommands: jest.fn() },
      startKickHttpServer,
      queueMessageService: { initPanel: jest.fn() },
      kickLinkPanelService: { initPanel: jest.fn() },
      schedulerService: { startScheduler: jest.fn() },
      sqliteBackupScheduler: { start: jest.fn() },
      subscriberRoleReconciliationScheduler: { start: jest.fn() },
      lifecycleService,
      gracefulShutdownService: { shutdown },
      logger: { info: jest.fn(), error: jest.fn() },
    });

    const result = await service.start({
      login,
      once: jest.fn(),
      removeListener: jest.fn(),
      isReady: jest.fn().mockReturnValue(false),
    });

    expect(result.started).toBe(false);
    expect(initDatabase).toHaveBeenCalledTimes(1);
    expect(startKickHttpServer).toHaveBeenCalledTimes(1);
    expect(lifecycleService.markFailed).toHaveBeenCalledWith('startup_failure');
    expect(lifecycleService.markReady).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'startup_failure',
        fatal: true,
      }),
    );
  });
});
