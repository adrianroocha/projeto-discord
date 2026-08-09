process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'guild-1';

const { EventEmitter } = require('events');
const { Events } = require('discord.js');
const { createAppBootstrapService } = require('../src/services/appBootstrapService');

describe('appBootstrapService', () => {
  test('falha parcial no bootstrap executa cleanup', async () => {
    const initDatabase = jest.fn().mockResolvedValue(undefined);
    const startKickHttpServer = jest.fn().mockResolvedValue({ started: true, host: '127.0.0.1', port: 3000 });
    const adminAuditRetentionStart = jest.fn().mockResolvedValue({ started: true });
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
      adminAuditRetentionScheduler: { start: adminAuditRetentionStart },
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
    expect(adminAuditRetentionStart).toHaveBeenCalledTimes(1);
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

  test('aguarda clientReady e não registra ready legado', async () => {
    const listeners = new Map();
    const discordClient = {
      login: jest.fn().mockResolvedValue('ok'),
      isReady: jest.fn().mockReturnValue(false),
      once: jest.fn((eventName, listener) => {
        listeners.set(eventName, listener);
        return discordClient;
      }),
      removeListener: jest.fn().mockReturnValue(undefined),
    };

    const service = createAppBootstrapService({
      config: {
        databasePath: './data/database.sqlite',
        discordToken: 'token',
      },
      database: { initDatabase: jest.fn().mockResolvedValue(undefined) },
      commandHandler: { registerCommands: jest.fn().mockResolvedValue(undefined) },
      startKickHttpServer: jest.fn().mockResolvedValue({ started: false }),
      queueMessageService: { initPanel: jest.fn().mockResolvedValue(undefined) },
      kickLinkPanelService: { initPanel: jest.fn().mockResolvedValue({ enabled: false }) },
      schedulerService: { startScheduler: jest.fn() },
      sqliteBackupScheduler: { start: jest.fn() },
      subscriberRoleReconciliationScheduler: { start: jest.fn() },
      adminAuditRetentionScheduler: { start: jest.fn().mockResolvedValue({ started: true }) },
      lifecycleService: { markReady: jest.fn(), markFailed: jest.fn() },
      gracefulShutdownService: { shutdown: jest.fn().mockResolvedValue({ exitCode: 1 }) },
      logger: { info: jest.fn(), error: jest.fn() },
    });

    const startPromise = service.start(discordClient);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(discordClient.once).toHaveBeenCalledWith(Events.ClientReady, expect.any(Function));
    expect(discordClient.once).not.toHaveBeenCalledWith('ready', expect.any(Function));

    listeners.get(Events.ClientReady)();
    const result = await startPromise;
    expect(result.started).toBe(true);
  });

  test('inicializa comandos, painéis e schedulers uma única vez', async () => {
    const initDatabase = jest.fn().mockResolvedValue(undefined);
    const registerCommands = jest.fn().mockResolvedValue(undefined);
    const queueInitPanel = jest.fn().mockResolvedValue(undefined);
    const kickInitPanel = jest.fn().mockResolvedValue({ enabled: true });
    const startScheduler = jest.fn();
    const backupStart = jest.fn();
    const subReconciliationStart = jest.fn();
    const adminAuditRetentionStart = jest.fn().mockResolvedValue({ started: true });
    const lifecycleService = {
      markReady: jest.fn(),
      markFailed: jest.fn(),
    };

    const discordClient = new EventEmitter();
    let ready = false;
    discordClient.isReady = () => ready;
    discordClient.login = jest.fn().mockImplementation(async () => {
      setTimeout(() => {
        ready = true;
        discordClient.emit(Events.ClientReady);
        discordClient.emit(Events.ClientReady);
      }, 0);
      return 'ok';
    });

    const service = createAppBootstrapService({
      config: {
        databasePath: './data/database.sqlite',
        discordToken: 'token',
      },
      database: { initDatabase },
      commandHandler: { registerCommands },
      startKickHttpServer: jest.fn().mockResolvedValue({ started: true, host: '127.0.0.1', port: 3000 }),
      queueMessageService: { initPanel: queueInitPanel },
      kickLinkPanelService: { initPanel: kickInitPanel },
      schedulerService: { startScheduler },
      sqliteBackupScheduler: { start: backupStart },
      subscriberRoleReconciliationScheduler: { start: subReconciliationStart },
      adminAuditRetentionScheduler: { start: adminAuditRetentionStart },
      lifecycleService,
      gracefulShutdownService: { shutdown: jest.fn().mockResolvedValue({ exitCode: 1 }) },
      logger: { info: jest.fn(), error: jest.fn() },
    });

    const result = await service.start(discordClient);

    expect(result.started).toBe(true);
    expect(initDatabase).toHaveBeenCalledTimes(1);
    expect(registerCommands).toHaveBeenCalledTimes(1);
    expect(queueInitPanel).toHaveBeenCalledTimes(1);
    expect(kickInitPanel).toHaveBeenCalledTimes(1);
    expect(startScheduler).toHaveBeenCalledTimes(1);
    expect(backupStart).toHaveBeenCalledTimes(1);
    expect(subReconciliationStart).toHaveBeenCalledTimes(1);
    expect(adminAuditRetentionStart).toHaveBeenCalledTimes(1);
    expect(lifecycleService.markReady).toHaveBeenCalledTimes(1);
    expect(lifecycleService.markFailed).not.toHaveBeenCalled();
  });
});
