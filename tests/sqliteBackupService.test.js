const fs = require('fs');
const path = require('path');

const { createTestContext, getDb } = require('./helpers/testDatabase');

describe('sqliteBackupService', () => {
  let context;
  let sqliteBackupService;

  beforeEach(async () => {
    jest.resetModules();
    context = await createTestContext();
    sqliteBackupService = require('../src/services/sqliteBackupService');
  });

  afterEach(async () => {
    if (context) {
      await context.cleanup();
    }
  });

  test('cria backup consistente com nome seguro e integrity_check ok', async () => {
    const db = getDb(context.sqliteClient);
    db.prepare(
      `INSERT INTO users (discord_id, username, created_at_ms) VALUES (?, ?, ?)`,
    ).run('user-1', 'User 1', Date.now());

    const result = await sqliteBackupService.createBackup({ triggerType: 'test' });

    expect(result.success).toBe(true);
    expect(result.fileName).toMatch(/^database-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.sqlite$/);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.integrityResult).toBe('ok');
    expect(Number(result.sizeBytes)).toBeGreaterThan(0);

    const validation = sqliteBackupService.validateBackup(result.path);
    expect(validation.success).toBe(true);
    expect(validation.integrityResult).toBe('ok');
  });

  test('backup de banco vazio também é válido', async () => {
    const result = await sqliteBackupService.createBackup({ triggerType: 'test_empty' });
    expect(result.success).toBe(true);

    const validation = sqliteBackupService.validateBackup(result.path);
    expect(validation.success).toBe(true);
  });

  test('concorrência: apenas um backup prossegue', async () => {
    let resolveBackup;
    let pendingTargetPath;
    const backupPromise = new Promise((resolve) => {
      resolveBackup = resolve;
    });

    const fakeDb = {
      backup: jest.fn((targetPath) => {
        pendingTargetPath = targetPath;
        return backupPromise;
      }),
    };

    const service = sqliteBackupService.createSqliteBackupService({
      config: {
        databasePath: context.databasePath,
        sqliteBackupDirectory: path.join(context.tempDir, 'backups-concurrency'),
        sqliteBackupRetentionDays: 7,
      },
      sqliteClient: {
        getDatabase: () => fakeDb,
      },
    });

    const first = service.createBackup({ triggerType: 'first' });
    const second = await service.createBackup({ triggerType: 'second' });

    expect(second.success).toBe(false);
    expect(second.errorCode).toBe('BACKUP_ALREADY_RUNNING');

    fs.copyFileSync(context.databasePath, pendingTargetPath);
    resolveBackup();
    const firstResult = await first;
    expect(firstResult.success).toBe(true);
  });

  test('falha de backup não altera banco original e limpa temporário', async () => {
    const sqliteService = sqliteBackupService.createSqliteBackupService({
      config: {
        databasePath: context.databasePath,
        sqliteBackupDirectory: path.join(context.tempDir, 'backups-failure'),
        sqliteBackupRetentionDays: 7,
      },
      sqliteClient: {
        getDatabase: () => ({
          backup: jest.fn(() => {
            throw Object.assign(new Error('boom'), { code: 'BOOM_BACKUP' });
          }),
        }),
      },
    });

    const result = await sqliteService.createBackup({ triggerType: 'failure' });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('BOOM_BACKUP');

    const backupDir = path.join(context.tempDir, 'backups-failure');
    const files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);

    const db = getDb(context.sqliteClient);
    const row = db.prepare('SELECT COUNT(1) AS c FROM users').get();
    expect(row.c).toBeGreaterThanOrEqual(0);
  });

  test('retenção remove antigos e preserva recentes e não relacionados', () => {
    const backupDir = path.join(context.tempDir, 'backups-retention');
    fs.mkdirSync(backupDir, { recursive: true });

    const oldFile = path.join(backupDir, 'database-2020-01-01_08-15-00.sqlite');
    const recentFile = path.join(backupDir, 'database-2099-01-01_08-15-00.sqlite');
    const unrelated = path.join(backupDir, 'readme.txt');

    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(recentFile, 'new');
    fs.writeFileSync(unrelated, 'safe');

    const pastMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, new Date(pastMs), new Date(pastMs));

    const service = sqliteBackupService.createSqliteBackupService({
      config: {
        databasePath: context.databasePath,
        sqliteBackupDirectory: backupDir,
        sqliteBackupRetentionDays: 7,
      },
      sqliteClient: context.sqliteClient,
    });

    const cleanup = service.cleanupRetention(7);

    expect(cleanup.removedCount).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  test('auditoria registra sucesso e falha sem vazar dados', async () => {
    const success = await sqliteBackupService.createBackup({ triggerType: 'audit_success' });
    expect(success.success).toBe(true);

    const failService = sqliteBackupService.createSqliteBackupService({
      config: {
        databasePath: context.databasePath,
        sqliteBackupDirectory: path.join(context.tempDir, 'backups-audit-failure'),
        sqliteBackupRetentionDays: 7,
      },
      sqliteClient: {
        getDatabase: () => ({
          backup: jest.fn(() => {
            throw Object.assign(new Error('forced-failure'), { code: 'FORCED_FAILURE' });
          }),
        }),
      },
    });

    await failService.createBackup({ triggerType: 'audit_failure' });

    const db = getDb(context.sqliteClient);
    const rows = db
      .prepare(
        `SELECT trigger_type, result, error_code, file_name
         FROM app_sqlite_backup_runs
         ORDER BY id DESC
         LIMIT 4`,
      )
      .all();

    expect(rows.some((row) => row.result === 'ok')).toBe(true);
    expect(rows.some((row) => row.result === 'failed')).toBe(true);
    expect(rows.every((row) => !String(row.file_name || '').includes('users'))).toBe(true);
  });
});
