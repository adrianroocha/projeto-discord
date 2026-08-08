const fs = require('fs');
const os = require('os');
const path = require('path');

function createTempDbPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-lock-tests-'));
  return {
    root,
    dbPath: path.join(root, 'data', 'database.sqlite'),
  };
}

describe('sqliteOperationalLockService', () => {
  afterEach(() => {
    delete process.env.RAILWAY_DEPLOYMENT_ID;
    delete process.env.RAILWAY_REPLICA_ID;
    jest.resetModules();
  });

  test('metadata inclui deploymentId e replicaId quando disponíveis', () => {
    const { root, dbPath } = createTempDbPath();
    process.env.RAILWAY_DEPLOYMENT_ID = 'dep-123';
    process.env.RAILWAY_REPLICA_ID = 'rep-456';

    const lockService = require('../src/services/sqliteOperationalLockService');
    const result = lockService.acquireLock(dbPath, { ownerTag: 'railway-test' });

    try {
      expect(result.acquired).toBe(true);
      const lockData = JSON.parse(fs.readFileSync(result.lockFilePath, 'utf8'));
      expect(lockData.railwayDeploymentId).toBe('dep-123');
      expect(lockData.railwayReplicaId).toBe('rep-456');
    } finally {
      lockService.releaseLock(dbPath);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('ambiente local sem variáveis Railway continua funcionando', () => {
    const { root, dbPath } = createTempDbPath();
    const lockService = require('../src/services/sqliteOperationalLockService');
    const result = lockService.acquireLock(dbPath);

    try {
      expect(result.acquired).toBe(true);
      const lockData = JSON.parse(fs.readFileSync(result.lockFilePath, 'utf8'));
      expect(lockData.railwayDeploymentId).toBeNull();
      expect(lockData.railwayReplicaId).toBeNull();
      expect(lockService.getHeartbeatIntervalMs()).toBe(30000);
      expect(lockService.getStaleThresholdMs()).toBe(120000);
    } finally {
      lockService.releaseLock(dbPath);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reconhece lock da própria instância', () => {
    const { root, dbPath } = createTempDbPath();
    const lockService = require('../src/services/sqliteOperationalLockService');

    try {
      const first = lockService.acquireLock(dbPath, { ownerTag: 'test' });
      const second = lockService.acquireLock(dbPath, { ownerTag: 'test' });

      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(true);
      expect(second.alreadyOwned).toBe(true);
    } finally {
      lockService.releaseLock(dbPath);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('bloqueia lock concorrente ativo', () => {
    const { root, dbPath } = createTempDbPath();
    const lockService = require('../src/services/sqliteOperationalLockService');
    const lockPath = lockService.lockPathFromDatabasePath(dbPath);

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 2,
        pid: process.pid,
        instanceToken: 'other-instance-token',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        ownerTag: 'other',
        databasePath: path.resolve(dbPath),
      }),
      'utf8',
    );

    try {
      const result = lockService.acquireLock(dbPath, { staleThresholdMs: 60_000 });
      expect(result.acquired).toBe(false);
      expect(result.active).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('recupera lock obsoleto após redeploy com PID reutilizado', () => {
    const { root, dbPath } = createTempDbPath();
    const lockService = require('../src/services/sqliteOperationalLockService');
    const lockPath = lockService.lockPathFromDatabasePath(dbPath);

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 2,
        pid: process.pid,
        instanceToken: 'old-container-token',
        createdAtMs: Date.now() - 600_000,
        updatedAtMs: Date.now() - 600_000,
        ownerTag: 'old',
        databasePath: path.resolve(dbPath),
      }),
      'utf8',
    );

    try {
      const result = lockService.acquireLock(dbPath, { staleThresholdMs: 1_000 });
      expect(result.acquired).toBe(true);
      expect(result.staleRemoved).toBe(true);
    } finally {
      lockService.releaseLock(dbPath);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('deployment Railway diferente recupera lock imediatamente', () => {
    const { root, dbPath } = createTempDbPath();
    process.env.RAILWAY_DEPLOYMENT_ID = 'new-deployment';
    process.env.RAILWAY_REPLICA_ID = 'replica-a';

    const lockService = require('../src/services/sqliteOperationalLockService');
    const lockPath = lockService.lockPathFromDatabasePath(dbPath);

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 2,
        pid: process.pid,
        instanceToken: 'old-token',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        ownerTag: 'old',
        databasePath: path.resolve(dbPath),
        railwayDeploymentId: 'old-deployment',
        railwayReplicaId: 'replica-old',
      }),
      'utf8',
    );

    try {
      const result = lockService.acquireLock(dbPath, { staleThresholdMs: 60_000 });
      expect(result.acquired).toBe(true);
      expect(result.recoveredByRailwayDeployment).toBe(true);
    } finally {
      lockService.releaseLock(dbPath);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('mesmo deployment com lock ativo não remove automaticamente', () => {
    const { root, dbPath } = createTempDbPath();
    process.env.RAILWAY_DEPLOYMENT_ID = 'same-deployment';
    process.env.RAILWAY_REPLICA_ID = 'replica-1';

    const lockService = require('../src/services/sqliteOperationalLockService');
    const lockPath = lockService.lockPathFromDatabasePath(dbPath);

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 2,
        pid: process.pid,
        instanceToken: 'other-instance-token',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        ownerTag: 'same-deploy-other-instance',
        databasePath: path.resolve(dbPath),
        railwayDeploymentId: 'same-deployment',
        railwayReplicaId: 'replica-2',
      }),
      'utf8',
    );

    try {
      const result = lockService.acquireLock(dbPath, { staleThresholdMs: 60_000 });
      expect(result.acquired).toBe(false);
      expect(result.active).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('release exige ownership por instanceToken', () => {
    const { root, dbPath } = createTempDbPath();
    const lockService = require('../src/services/sqliteOperationalLockService');
    const lockPath = lockService.lockPathFromDatabasePath(dbPath);

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 2,
        pid: process.pid,
        instanceToken: 'foreign-instance-token',
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        ownerTag: 'foreign',
        databasePath: path.resolve(dbPath),
      }),
      'utf8',
    );

    try {
      expect(() => lockService.releaseLock(dbPath)).toThrow(/Falha ao remover lock operacional do SQLite/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('libera lock no shutdown do sqliteClient', async () => {
    const { root, dbPath } = createTempDbPath();

    process.env.DISCORD_TOKEN = 'test-token';
    process.env.GUILD_ID = 'test-guild';
    process.env.DATABASE_PATH = dbPath;

    jest.resetModules();

    const sqliteClient = require('../src/database/sqliteClient');

    try {
      await sqliteClient.openConnection();
      const lockPath = `${path.resolve(dbPath)}.lock`;
      expect(fs.existsSync(lockPath)).toBe(true);

      await sqliteClient.closeConnection();
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      delete process.env.DATABASE_PATH;
      delete process.env.DISCORD_TOKEN;
      delete process.env.GUILD_ID;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('arquivo de lock fica no diretório persistente configurado', () => {
    const { root, dbPath } = createTempDbPath();
    const lockService = require('../src/services/sqliteOperationalLockService');

    try {
      const result = lockService.acquireLock(dbPath);
      expect(result.acquired).toBe(true);
      expect(result.lockFilePath).toBe(path.join(path.dirname(path.resolve(dbPath)), 'database.sqlite.lock'));
      expect(fs.existsSync(result.lockFilePath)).toBe(true);
    } finally {
      lockService.releaseLock(dbPath);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
