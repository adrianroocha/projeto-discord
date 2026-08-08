const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

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
      emitter.emit('ready');
    }, 0);
    return 'ok';
  });

  return emitter;
}

describe('Railway bootstrap lock recovery', () => {
  afterEach(() => {
    delete process.env.DISCORD_TOKEN;
    delete process.env.GUILD_ID;
    delete process.env.DATABASE_PATH;
    delete process.env.RAILWAY_DEPLOYMENT_ID;
    delete process.env.RAILWAY_REPLICA_ID;
    jest.resetModules();
  });

  test('SIGKILL simulado seguido de novo deployment recupera lock e chega a ready', async () => {
    const { root, dbPath } = createTempDbPath();

    process.env.DISCORD_TOKEN = 'test-token';
    process.env.GUILD_ID = 'test-guild';
    process.env.DATABASE_PATH = dbPath;
    process.env.RAILWAY_DEPLOYMENT_ID = 'deployment-new';
    process.env.RAILWAY_REPLICA_ID = 'replica-new';

    const lockPath = `${path.resolve(dbPath)}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    // Simula lock deixado por container antigo que morreu sem cleanup (SIGKILL).
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
        railwayDeploymentId: 'deployment-old',
        railwayReplicaId: 'replica-old',
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

      expect(result.started).toBe(true);
      expect(lifecycleService.markReady).toHaveBeenCalledTimes(1);
      expect(lifecycleService.markFailed).not.toHaveBeenCalled();
      expect(sqliteClient.isConnectionOpen()).toBe(true);

      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(lockData.railwayDeploymentId).toBe('deployment-new');
      expect(lockData.railwayReplicaId).toBe('replica-new');
    } finally {
      await sqliteClient.closeConnection();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
