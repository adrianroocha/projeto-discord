const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Events } = require('discord.js');

function createTempDbPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'railway-bootstrap-lock-'));
  return {
    root,
    dbPath: path.join(root, 'data', 'database.sqlite'),
  };
}

function createDiscordClientStub() {
  const emitter = new EventEmitter();
  let ready = false;

  emitter.isReady = () => ready;
  emitter.login = jest.fn().mockImplementation(async () => {
    setTimeout(() => {
      ready = true;
      emitter.emit(Events.ClientReady);
    }, 0);
    return 'ok';
  });

  return emitter;
}

describe('Railway bootstrap lock safety', () => {
  afterEach(() => {
    delete process.env.DISCORD_TOKEN;
    delete process.env.GUILD_ID;
    delete process.env.DATABASE_PATH;
    delete process.env.RAILWAY_DEPLOYMENT_ID;
    delete process.env.RAILWAY_REPLICA_ID;
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    jest.resetModules();
  });

  test('lock deixado por instância anterior bloqueia bootstrap até recuperação manual', async () => {
    const { root, dbPath } = createTempDbPath();

    process.env.DISCORD_TOKEN = 'test-token';
    process.env.GUILD_ID = 'test-guild';
    process.env.DATABASE_PATH = dbPath;
    process.env.RAILWAY_DEPLOYMENT_ID = 'deployment-same';
    process.env.RAILWAY_REPLICA_ID = 'replica-same';
    process.env.RAILWAY_VOLUME_MOUNT_PATH = root;

    const lockPath = `${path.resolve(dbPath)}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    // Simula lock abandonado por container anterior. A recuperação é manual e fail-closed.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 2,
        pid: 1,
        instanceToken: 'old-container-token',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        ownerTag: 'old-container',
        databasePath: path.resolve(dbPath),
        railwayDeploymentId: 'deployment-same',
        railwayReplicaId: 'replica-same',
      }),
      'utf8',
    );

    const { createAppBootstrapService } = require('../src/services/appBootstrapService');
    const sqliteClient = require('../src/database/sqliteClient');

    const lifecycleService = {
      markReady: jest.fn(),
      markFailed: jest.fn(),
    };

    const shutdown = jest.fn().mockResolvedValue({ exitCode: 1 });

    const service = createAppBootstrapService({
      commandHandler: { registerCommands: jest.fn().mockResolvedValue(undefined) },
      startKickHttpServer: jest.fn().mockResolvedValue({ started: true, host: '0.0.0.0', port: 3000 }),
      queueMessageService: { initPanel: jest.fn().mockResolvedValue(undefined) },
      kickLinkPanelService: { initPanel: jest.fn().mockResolvedValue({ enabled: false }) },
      schedulerService: { startScheduler: jest.fn() },
      sqliteBackupScheduler: { start: jest.fn() },
      subscriberRoleReconciliationScheduler: { start: jest.fn() },
      lifecycleService,
      gracefulShutdownService: { shutdown },
      logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    });

    const discordClient = createDiscordClientStub();

    try {
      const result = await service.start(discordClient);

      expect(result.started).toBe(false);
      expect(lifecycleService.markReady).not.toHaveBeenCalled();
      expect(lifecycleService.markFailed).toHaveBeenCalledWith('startup_failure');
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(sqliteClient.isConnectionOpen()).toBe(false);

      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(lockData.instanceToken).toBe('old-container-token');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
