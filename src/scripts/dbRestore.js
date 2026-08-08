require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const config = require('../config');
const sqliteBackupService = require('../services/sqliteBackupService');
const sqliteOperationalLockService = require('../services/sqliteOperationalLockService');

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = {
    file: null,
    confirm: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--confirm') {
      out.confirm = true;
    } else if (token === '--file') {
      const value = args[index + 1];
      if (typeof value === 'string' && value.trim()) {
        out.file = value.trim();
      }
      index += 1;
    }
  }

  return out;
}

function fail(message, code = 1) {
  console.error(message);
  process.exitCode = code;
}

function ensureInsideDirectory(filePath, directoryPath) {
  const absoluteFilePath = path.resolve(filePath);
  const absoluteDirectoryPath = path.resolve(directoryPath);
  const relative = path.relative(absoluteDirectoryPath, absoluteFilePath);
  if (!relative) {
    return true;
  }
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeInputBackupPath(fileInput, backupDirectory) {
  if (typeof fileInput !== 'string' || !fileInput.trim()) {
    throw Object.assign(new Error('Informe --file <nome-ou-caminho-controlado>.'), {
      code: 'RESTORE_FILE_REQUIRED',
    });
  }

  const candidate = fileInput.trim();
  const containsPathSeparator = candidate.includes('/') || candidate.includes('\\');
  const resolved = containsPathSeparator || path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(path.join(backupDirectory, candidate));

  if (!ensureInsideDirectory(resolved, backupDirectory)) {
    throw Object.assign(new Error('Restore bloqueado: arquivo fora de SQLITE_BACKUP_DIRECTORY.'), {
      code: 'RESTORE_PATH_OUTSIDE_BACKUP_DIR',
    });
  }

  const fileName = path.basename(resolved);
  if (!/^[A-Za-z0-9._-]+\.sqlite$/.test(fileName)) {
    throw Object.assign(new Error('Restore bloqueado: nome de arquivo inválido.'), {
      code: 'RESTORE_INVALID_FILE_NAME',
    });
  }

  return resolved;
}

function probeDatabaseIsUnused(databasePath) {
  const lockStatus = sqliteOperationalLockService.inspectLock(databasePath);
  if (lockStatus.exists && lockStatus.active) {
    throw Object.assign(new Error('Restore bloqueado: lock operacional ativo indica banco em uso.'), {
      code: 'RESTORE_LOCK_ACTIVE',
    });
  }

  let db;
  try {
    db = new Database(databasePath, { readonly: false, fileMustExist: true });
    db.pragma('busy_timeout = 1');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('ROLLBACK');
  } catch (error) {
    throw Object.assign(new Error('Restore bloqueado: não foi possível obter lock exclusivo do SQLite.'), {
      code: 'RESTORE_DB_BUSY',
      cause: error,
    });
  } finally {
    if (db) {
      db.close();
    }
  }
}

async function createPreRestoreBackup(databasePath, backupDirectory) {
  const startedAtMs = Date.now();
  const preName = `pre-restore-${startedAtMs}.sqlite`;
  const preFinalPath = path.join(backupDirectory, preName);
  const preTempPath = `${preFinalPath}.tmp`;

  let db;
  try {
    db = new Database(databasePath, { readonly: false, fileMustExist: true });
    await db.backup(preTempPath);
    sqliteBackupService.validateBackup(preTempPath);
    fs.renameSync(preTempPath, preFinalPath);
    sqliteBackupService.validateBackup(preFinalPath);
    return {
      fileName: preName,
      path: preFinalPath,
    };
  } catch (error) {
    if (fs.existsSync(preTempPath)) {
      try {
        fs.unlinkSync(preTempPath);
      } catch (_cleanupError) {
        // no-op
      }
    }

    throw Object.assign(new Error('Falha ao criar backup de segurança pré-restore.'), {
      code: error.code || 'PRE_RESTORE_BACKUP_FAILED',
    });
  } finally {
    if (db) {
      db.close();
    }
  }
}

function restoreAtomically(options) {
  const sourceBackupPath = options.sourceBackupPath;
  const databasePath = options.databasePath;
  const dbDir = path.dirname(databasePath);
  const restoreTempPath = path.join(dbDir, `restore-${Date.now()}-${process.pid}.tmp.sqlite`);
  const previousDbPath = path.join(dbDir, `restore-previous-${Date.now()}-${process.pid}.sqlite`);

  let renamedOriginal = false;
  let restored = false;

  try {
    fs.copyFileSync(sourceBackupPath, restoreTempPath);
    sqliteBackupService.validateBackup(restoreTempPath);

    fs.renameSync(databasePath, previousDbPath);
    renamedOriginal = true;

    fs.renameSync(restoreTempPath, databasePath);
    restored = true;

    sqliteBackupService.validateBackup(databasePath);

    return {
      restored: true,
      previousDbPath,
      restoreTempPath,
      rollbackNeeded: false,
    };
  } catch (error) {
    if (restored) {
      try {
        const failedRestoredPath = `${databasePath}.failed-${Date.now()}.sqlite`;
        if (fs.existsSync(databasePath)) {
          fs.renameSync(databasePath, failedRestoredPath);
        }
      } catch (_renameFailed) {
        // no-op
      }
    }

    if (renamedOriginal) {
      try {
        if (!fs.existsSync(databasePath) && fs.existsSync(previousDbPath)) {
          fs.renameSync(previousDbPath, databasePath);
        }
      } catch (_rollbackError) {
        // no-op
      }
    }

    if (fs.existsSync(restoreTempPath)) {
      try {
        fs.unlinkSync(restoreTempPath);
      } catch (_cleanupError) {
        // no-op
      }
    }

    throw Object.assign(new Error('Falha durante restauração atômica do SQLite.'), {
      code: error.code || 'RESTORE_ATOMIC_SWAP_FAILED',
    });
  }
}

function cleanupAfterSuccess(previousDbPath) {
  if (previousDbPath && fs.existsSync(previousDbPath)) {
    fs.unlinkSync(previousDbPath);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.confirm) {
    fail(
      'Restore offline bloqueado sem --confirm. Uso: npm run db:restore -- --file <nome-ou-caminho-controlado> --confirm',
      2,
    );
    return;
  }

  try {
    const resolvedDatabasePath = path.resolve(config.databasePath);
    const backupDirectory = path.resolve(config.sqliteBackupDirectory || './backups');

    fs.mkdirSync(backupDirectory, { recursive: true });

    const sourceBackupPath = normalizeInputBackupPath(args.file, backupDirectory);
    if (!fs.existsSync(sourceBackupPath)) {
      throw Object.assign(new Error('Arquivo de backup informado não existe.'), {
        code: 'RESTORE_SOURCE_NOT_FOUND',
      });
    }

    if (path.resolve(sourceBackupPath) === resolvedDatabasePath) {
      throw Object.assign(new Error('Restore bloqueado: origem não pode ser o DATABASE_PATH ativo.'), {
        code: 'RESTORE_SOURCE_IS_ACTIVE_DB',
      });
    }

    sqliteBackupService.validateBackup(sourceBackupPath);
    probeDatabaseIsUnused(resolvedDatabasePath);

    const preRestore = await createPreRestoreBackup(resolvedDatabasePath, backupDirectory);
    const restoreResult = restoreAtomically({
      sourceBackupPath,
      databasePath: resolvedDatabasePath,
    });

    try {
      sqliteBackupService.validateBackup(resolvedDatabasePath);
    } catch (validationError) {
      try {
        if (fs.existsSync(resolvedDatabasePath) && fs.existsSync(restoreResult.previousDbPath)) {
          const badPath = `${resolvedDatabasePath}.invalid-${Date.now()}.sqlite`;
          fs.renameSync(resolvedDatabasePath, badPath);
          fs.renameSync(restoreResult.previousDbPath, resolvedDatabasePath);
          sqliteBackupService.validateBackup(resolvedDatabasePath);
        }
      } catch (_rollbackError) {
        throw Object.assign(new Error('Validação final falhou e rollback não pôde ser concluído.'), {
          code: 'RESTORE_FINAL_VALIDATION_AND_ROLLBACK_FAILED',
        });
      }

      throw Object.assign(new Error('Validação final falhou. Restore revertido para banco anterior.'), {
        code: validationError.code || 'RESTORE_FINAL_VALIDATION_FAILED',
      });
    }

    cleanupAfterSuccess(restoreResult.previousDbPath);

    console.log(`Restore concluído com sucesso. origem=${path.basename(sourceBackupPath)}`);
    console.log(`Backup pré-restore: ${preRestore.fileName}`);
    process.exitCode = 0;
  } catch (error) {
    fail(`Restore falhou. code=${error.code || error.name || 'DB_RESTORE_FAILED'}`, 1);
  }
}

main();
