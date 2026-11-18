const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const sqliteOperationalLockService = require('../src/services/sqliteOperationalLockService');

function createTempWorkspace() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projeto-discord-cli-'));
  const databasePath = path.join(tempDir, 'database.sqlite');
  const backupDir = path.join(tempDir, 'backups');
  return { tempDir, databasePath, backupDir };
}

function initializeTestDatabase(databasePath) {
  const db = new Database(databasePath);
  db.exec(
    `CREATE TABLE users (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`,
  );
  db.close();
}

function createEnv(paths) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  return {
    ...env,
    NODE_ENV: 'production',
    DATABASE_PATH: paths.databasePath,
    SQLITE_BACKUP_DIRECTORY: paths.backupDir,
    SQLITE_BACKUP_ENABLED: 'true',
    SQLITE_BACKUP_TIME: '08:15',
    SQLITE_BACKUP_TIMEZONE: 'America/Sao_Paulo',
    SQLITE_BACKUP_RETENTION_DAYS: '7',
    SQLITE_BACKUP_STARTUP_DELAY_SECONDS: '1',
    DISCORD_TOKEN: 'test-token',
    GUILD_ID: 'test-guild',
  };
}

function loadBackupModulesWithTestConfig(paths) {
  const testConfigEnv = {
    DATABASE_PATH: paths.databasePath,
    SQLITE_BACKUP_DIRECTORY: paths.backupDir,
    DISCORD_TOKEN: 'test-token',
    GUILD_ID: 'test-guild',
  };
  const previousEnv = Object.fromEntries(
    Object.keys(testConfigEnv).map((key) => [key, process.env[key]]),
  );

  try {
    Object.assign(process.env, testConfigEnv);
    jest.doMock('dotenv', () => ({ config: jest.fn() }));
    jest.resetModules();
    return {
      backupService: require('../src/services/sqliteBackupService'),
      restoreCommand: require('../src/scripts/dbRestore'),
    };
  } finally {
    jest.dontMock('dotenv');
    jest.resetModules();
    for (const key of Object.keys(testConfigEnv)) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
  }
}

function runScript(scriptRelativePath, args, env) {
  const projectRoot = process.cwd();
  return spawnSync(process.execPath, [path.join(projectRoot, scriptRelativePath), ...(args || [])], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
}

function listSqliteBackups(backupDir) {
  if (!fs.existsSync(backupDir)) {
    return [];
  }
  return fs
    .readdirSync(backupDir)
    .filter((name) => /\.sqlite$/.test(name))
    .sort();
}

describe('sqlite backup CLI scripts', () => {
  let paths;

  beforeEach(() => {
    paths = createTempWorkspace();
    initializeTestDatabase(paths.databasePath);
  });

  afterEach(() => {
    if (paths && fs.existsSync(paths.tempDir)) {
      fs.rmSync(paths.tempDir, { recursive: true, force: true });
    }
  });

  test('db:backup executa com sucesso e cria arquivo', () => {
    const env = createEnv(paths);
    const result = runScript('src/scripts/dbBackup.js', [], env);

    expect(result.status).toBe(0);
    const backups = listSqliteBackups(paths.backupDir).filter((name) => name.startsWith('database-'));
    expect(backups.length).toBeGreaterThan(0);
    const db = new Database(paths.databasePath, { readonly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    db.close();
    expect(tables).toEqual(['users']);
  });

  test('db:backup não cria banco ausente nem inicializa esquema', () => {
    fs.rmSync(paths.databasePath);
    const result = runScript('src/scripts/dbBackup.js', [], createEnv(paths));

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(paths.databasePath)).toBe(false);
    expect(fs.existsSync(`${paths.databasePath}.lock`)).toBe(false);
  });

  test('db:backup falha sem abrir banco quando o bot possui o lock', () => {
    const lock = sqliteOperationalLockService.acquireLock(paths.databasePath, {
      ownerTag: 'test-main-process',
    });
    const originalLock = fs.readFileSync(lock.lockFilePath, 'utf8');

    try {
      const result = runScript('src/scripts/dbBackup.js', [], createEnv(paths));

      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(lock.lockFilePath, 'utf8')).toBe(originalLock);
      expect(listSqliteBackups(paths.backupDir)).toHaveLength(0);
    } finally {
      sqliteOperationalLockService.releaseLock(paths.databasePath);
    }
  });

  test('falha no backup CLI libera a conexão e o lock', () => {
    const backupPathIsFile = paths.backupDir;
    fs.writeFileSync(backupPathIsFile, 'not a directory');

    const result = runScript('src/scripts/dbBackup.js', [], createEnv(paths));

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(`${paths.databasePath}.lock`)).toBe(false);
  });

  test('db:backup:status exibe apenas metadados seguros', () => {
    const env = createEnv(paths);
    const backupResult = runScript('src/scripts/dbBackup.js', [], env);
    expect(backupResult.status).toBe(0);

    const statusResult = runScript('src/scripts/dbBackupStatus.js', [], env);
    expect(statusResult.status).toBe(0);
    expect(statusResult.stdout).toContain('Backups disponíveis (metadados seguros):');
    expect(statusResult.stdout).not.toContain('SELECT');
  });

  test('db:backup:status valida arquivos sem abrir ou criar o banco ativo', () => {
    const backupPath = path.join(paths.backupDir, 'database-2025-01-01_00-00-00.sqlite');
    fs.mkdirSync(paths.backupDir, { recursive: true });
    fs.copyFileSync(paths.databasePath, backupPath);
    fs.rmSync(paths.databasePath);

    const result = runScript('src/scripts/dbBackupStatus.js', [], createEnv(paths));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Auditoria de execuções indisponível');
    expect(result.stdout).toContain('integridade=ok');
    expect(fs.existsSync(paths.databasePath)).toBe(false);
    expect(fs.existsSync(`${paths.databasePath}.lock`)).toBe(false);
  });

  test('restore sem --confirm não altera banco', () => {
    const env = createEnv(paths);
    expect(runScript('src/scripts/dbBackup.js', [], env).status).toBe(0);

    const backupFile = listSqliteBackups(paths.backupDir).find((name) => name.startsWith('database-'));
    expect(backupFile).toBeTruthy();

    const db = new Database(paths.databasePath);
    db.prepare(`INSERT INTO users (discord_id, username, created_at_ms) VALUES (?, ?, ?)`).run(
      'user-before-confirm',
      'User Confirm',
      Date.now(),
    );
    const before = db.prepare('SELECT COUNT(1) AS c FROM users').get().c;
    db.close();

    const result = runScript('src/scripts/dbRestore.js', ['--file', backupFile], env);
    expect(result.status).not.toBe(0);

    const verifyDb = new Database(paths.databasePath);
    const after = verifyDb.prepare('SELECT COUNT(1) AS c FROM users').get().c;
    verifyDb.close();

    expect(after).toBe(before);
  });

  test('restore bloqueia path traversal', () => {
    const env = createEnv(paths);
    expect(runScript('src/scripts/dbBackup.js', [], env).status).toBe(0);

    const result = runScript(
      'src/scripts/dbRestore.js',
      ['--file', '..\\outside.sqlite', '--confirm'],
      env,
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('RESTORE_PATH_OUTSIDE_BACKUP_DIR');
  });

  test('restore bloqueia link simbólico para backup fora do diretório', () => {
    const env = createEnv(paths);
    fs.mkdirSync(paths.backupDir, { recursive: true });
    const outsideDirectory = path.join(paths.tempDir, 'outside');
    const linkedDirectory = path.join(paths.backupDir, 'linked');
    const backupName = 'database-2025-01-01_00-00-00.sqlite';
    fs.mkdirSync(outsideDirectory);
    fs.copyFileSync(paths.databasePath, path.join(outsideDirectory, backupName));

    try {
      fs.symlinkSync(
        outsideDirectory,
        linkedDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        return;
      }
      throw error;
    }

    const result = runScript(
      'src/scripts/dbRestore.js',
      ['--file', path.join(linkedDirectory, backupName), '--confirm'],
      env,
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('RESTORE_PATH_OUTSIDE_BACKUP_DIR');
  });

  test('restore válido aplica backup e cria pre-restore', () => {
    const env = createEnv(paths);
    expect(runScript('src/scripts/dbBackup.js', [], env).status).toBe(0);

    const backupFile = listSqliteBackups(paths.backupDir).find((name) => name.startsWith('database-'));
    expect(backupFile).toBeTruthy();

    const db = new Database(paths.databasePath);
    db.prepare(`INSERT INTO users (discord_id, username, created_at_ms) VALUES (?, ?, ?)`).run(
      'user-restore',
      'User Restore',
      Date.now(),
    );
    const beforeRestoreCount = db.prepare('SELECT COUNT(1) AS c FROM users').get().c;
    expect(beforeRestoreCount).toBe(1);
    db.close();

    const result = runScript(
      'src/scripts/dbRestore.js',
      ['--file', backupFile, '--confirm'],
      env,
    );

    expect(result.status).toBe(0);

    const verifyDb = new Database(paths.databasePath);
    const restoredCount = verifyDb.prepare('SELECT COUNT(1) AS c FROM users').get().c;
    verifyDb.close();
    expect(restoredCount).toBe(0);

    const preRestore = listSqliteBackups(paths.backupDir).filter((name) => name.startsWith('pre-restore-'));
    expect(preRestore.length).toBeGreaterThan(0);
  });

  test('restore bloqueia banco em uso por lock operacional ativo', () => {
    const env = createEnv(paths);
    expect(runScript('src/scripts/dbBackup.js', [], env).status).toBe(0);

    const backupFile = listSqliteBackups(paths.backupDir).find((name) => name.startsWith('database-'));
    expect(backupFile).toBeTruthy();

    const lockPath = `${paths.databasePath}.lock`;
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), ownerTag: 'test' })}\n`,
      'utf8',
    );

    const result = runScript(
      'src/scripts/dbRestore.js',
      ['--file', backupFile, '--confirm'],
      env,
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('RESTORE_LOCK_ACTIVE');
  });

  test('restore recusa sidecars sem alterar banco ou removê-los', () => {
    const env = createEnv(paths);
    expect(runScript('src/scripts/dbBackup.js', [], env).status).toBe(0);
    const backupFile = listSqliteBackups(paths.backupDir).find((name) => name.startsWith('database-'));
    const before = fs.readFileSync(paths.databasePath);
    const walPath = `${paths.databasePath}-wal`;
    fs.writeFileSync(walPath, 'preserve sidecar');

    const result = runScript('src/scripts/dbRestore.js', ['--file', backupFile, '--confirm'], env);

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('RESTORE_DATABASE_SIDECAR_PRESENT');
    expect(fs.readFileSync(paths.databasePath)).toEqual(before);
    expect(fs.readFileSync(walPath, 'utf8')).toBe('preserve sidecar');
    expect(fs.existsSync(`${paths.databasePath}.lock`)).toBe(false);
  });

  test('restore mantém exclusividade durante verificações e a libera ao terminar', async () => {
    const env = createEnv(paths);
    expect(runScript('src/scripts/dbBackup.js', [], env).status).toBe(0);
    const backupFile = listSqliteBackups(paths.backupDir).find((name) => name.startsWith('database-'));
    const previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_PATH: process.env.DATABASE_PATH,
      SQLITE_BACKUP_DIRECTORY: process.env.SQLITE_BACKUP_DIRECTORY,
      SQLITE_BACKUP_ENABLED: process.env.SQLITE_BACKUP_ENABLED,
      SQLITE_BACKUP_TIME: process.env.SQLITE_BACKUP_TIME,
      SQLITE_BACKUP_TIMEZONE: process.env.SQLITE_BACKUP_TIMEZONE,
      SQLITE_BACKUP_RETENTION_DAYS: process.env.SQLITE_BACKUP_RETENTION_DAYS,
      SQLITE_BACKUP_STARTUP_DELAY_SECONDS: process.env.SQLITE_BACKUP_STARTUP_DELAY_SECONDS,
      DISCORD_TOKEN: process.env.DISCORD_TOKEN,
      GUILD_ID: process.env.GUILD_ID,
    };
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const restoreEnvKeys = [
      'NODE_ENV',
      'DATABASE_PATH',
      'SQLITE_BACKUP_DIRECTORY',
      'SQLITE_BACKUP_ENABLED',
      'SQLITE_BACKUP_TIME',
      'SQLITE_BACKUP_TIMEZONE',
      'SQLITE_BACKUP_RETENTION_DAYS',
      'SQLITE_BACKUP_STARTUP_DELAY_SECONDS',
      'DISCORD_TOKEN',
      'GUILD_ID',
    ];
    let validationSpy;
    let restoreLockService;
    let competingLockService;

    try {
      Object.assign(process.env, env);
      jest.resetModules();
      const backupService = require('../src/services/sqliteBackupService');
      const originalValidate = backupService.validateBackup;
      restoreLockService = require('../src/services/sqliteOperationalLockService');
      jest.isolateModules(() => {
        competingLockService = require('../src/services/sqliteOperationalLockService');
      });

      const acquisitionAttempts = [];
      validationSpy = jest.spyOn(backupService, 'validateBackup').mockImplementation((filePath) => {
        acquisitionAttempts.push(competingLockService.acquireLock(paths.databasePath));
        return originalValidate(filePath);
      });

      const restoreCommand = require('../src/scripts/dbRestore');
      process.argv = [
        process.execPath,
        path.resolve('src/scripts/dbRestore.js'),
        '--file',
        backupFile,
        '--confirm',
      ];
      await restoreCommand.main();

      expect(process.exitCode).toBe(0);
      expect(acquisitionAttempts.length).toBeGreaterThanOrEqual(4);
      expect(acquisitionAttempts.every((attempt) => !attempt.acquired)).toBe(true);

      const afterRestore = competingLockService.acquireLock(paths.databasePath);
      expect(afterRestore.acquired).toBe(true);
      competingLockService.releaseLock(paths.databasePath);
    } finally {
      if (validationSpy) {
        validationSpy.mockRestore();
      }
      process.argv = previousArgv;
      process.exitCode = typeof previousExitCode === 'number' ? previousExitCode : 0;
      for (const key of restoreEnvKeys) {
        if (previousEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previousEnv[key];
        }
      }
      if (
        restoreLockService &&
        restoreLockService.inspectLock(paths.databasePath).ownedByCurrentInstance
      ) {
        restoreLockService.releaseLock(paths.databasePath);
      }
      if (
        competingLockService &&
        competingLockService.inspectLock(paths.databasePath).ownedByCurrentInstance
      ) {
        competingLockService.releaseLock(paths.databasePath);
      }
      jest.resetModules();
    }
  });

  test('falha após troca faz rollback e preserva o banco anterior', () => {
    const sourcePath = path.join(paths.tempDir, 'source.sqlite');
    fs.copyFileSync(paths.databasePath, sourcePath);
    const originalDatabase = fs.readFileSync(paths.databasePath);
    const { backupService, restoreCommand } = loadBackupModulesWithTestConfig(paths);
    const realValidate = backupService.validateBackup.bind(backupService);
    const validate = jest.spyOn(backupService, 'validateBackup');
    validate
      .mockImplementationOnce((filePath) => realValidate(filePath))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('simulated post-swap validation failure'), {
          code: 'RESTORE_TEST_VALIDATION_FAILED',
        });
      });

    try {
      expect(() =>
        restoreCommand.restoreAtomically({
          sourceBackupPath: sourcePath,
          databasePath: paths.databasePath,
        }),
      ).toThrow('Falha durante restauração atômica do SQLite.');
      expect(fs.readFileSync(paths.databasePath)).toEqual(originalDatabase);
    } finally {
      validate.mockRestore();
      jest.resetModules();
    }
  });

  test('restore libera o lock quando o rollback termina com sucesso', () => {
    const env = createEnv(paths);
    const sourcePath = path.join(paths.backupDir, 'source.sqlite');
    fs.mkdirSync(paths.backupDir, { recursive: true });
    fs.copyFileSync(paths.databasePath, sourcePath);
    const originalDatabase = fs.readFileSync(paths.databasePath);
    const childScript = `
      const path = require('path');
      const backupService = require(${JSON.stringify(path.resolve('src/services/sqliteBackupService'))});
      const databasePath = path.resolve(${JSON.stringify(paths.databasePath)});
      const validateBackup = backupService.validateBackup.bind(backupService);
      backupService.validateBackup = (filePath) => {
        if (path.resolve(filePath) === databasePath) {
          throw Object.assign(new Error('simulated post-swap validation failure'), {
            code: 'RESTORE_TEST_VALIDATION_FAILED',
          });
        }
        return validateBackup(filePath);
      };
      process.argv = [
        process.execPath,
        path.resolve('src/scripts/dbRestore.js'),
        '--file',
        ${JSON.stringify(path.basename(sourcePath))},
        '--confirm',
      ];
      require(${JSON.stringify(path.resolve('src/scripts/dbRestore'))}).main();
    `;

    const result = spawnSync(process.execPath, ['-e', childScript], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(fs.readFileSync(paths.databasePath)).toEqual(originalDatabase);
    expect(fs.existsSync(`${paths.databasePath}.lock`)).toBe(false);
  });

  test('restore mantém lock e arquivos de recuperação se o rollback falhar', () => {
    const env = createEnv(paths);
    const sourcePath = path.join(paths.backupDir, 'source.sqlite');
    fs.mkdirSync(paths.backupDir, { recursive: true });
    fs.copyFileSync(paths.databasePath, sourcePath);
    const childScript = `
      const fs = require('fs');
      const path = require('path');
      const backupService = require(${JSON.stringify(path.resolve('src/services/sqliteBackupService'))});
      const databasePath = path.resolve(${JSON.stringify(paths.databasePath)});
      const validateBackup = backupService.validateBackup.bind(backupService);
      backupService.validateBackup = (filePath) => {
        if (path.resolve(filePath) === databasePath) {
          throw Object.assign(new Error('simulated post-swap validation failure'), {
            code: 'RESTORE_TEST_VALIDATION_FAILED',
          });
        }
        return validateBackup(filePath);
      };
      const renameSync = fs.renameSync.bind(fs);
      fs.renameSync = (from, to) => {
        if (
          path.resolve(to) === databasePath &&
          path.basename(path.resolve(from)).startsWith('restore-previous-')
        ) {
          throw Object.assign(new Error('simulated rollback rename failure'), { code: 'EIO' });
        }
        return renameSync(from, to);
      };
      process.argv = [
        process.execPath,
        path.resolve('src/scripts/dbRestore.js'),
        '--file',
        ${JSON.stringify(path.basename(sourcePath))},
        '--confirm',
      ];
      require(${JSON.stringify(path.resolve('src/scripts/dbRestore'))}).main();
    `;

    const result = spawnSync(process.execPath, ['-e', childScript], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toContain('RESTORE_ROLLBACK_FAILED');
    expect(`${result.stderr}${result.stdout}`).toContain('Intervenção manual obrigatória');
    expect(fs.existsSync(`${paths.databasePath}.lock`)).toBe(true);

    const recoveryFiles = fs.readdirSync(path.dirname(paths.databasePath));
    const previousFile = recoveryFiles.find((name) => name.startsWith('restore-previous-'));
    const failedFile = recoveryFiles.find((name) => name.startsWith('database.sqlite.failed-'));
    expect(previousFile).toBeTruthy();
    expect(failedFile).toBeTruthy();
    expect(fs.statSync(path.join(path.dirname(paths.databasePath), previousFile)).size).toBeGreaterThan(0);
    expect(fs.statSync(path.join(path.dirname(paths.databasePath), failedFile)).size).toBeGreaterThan(0);

    const competingLock = sqliteOperationalLockService.acquireLock(paths.databasePath, {
      ownerTag: 'competing-instance',
    });
    expect(competingLock.acquired).toBe(false);
  });
});
