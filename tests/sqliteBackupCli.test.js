const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

function createTempWorkspace() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projeto-discord-cli-'));
  const databasePath = path.join(tempDir, 'database.sqlite');
  const backupDir = path.join(tempDir, 'backups');
  return { tempDir, databasePath, backupDir };
}

function createEnv(paths) {
  return {
    ...process.env,
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
});
