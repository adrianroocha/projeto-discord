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

function assertRealPathInsideDirectory(filePath, directoryPath) {
  const realFilePath = fs.realpathSync(filePath);
  const realDirectoryPath = fs.realpathSync(directoryPath);
  if (!ensureInsideDirectory(realFilePath, realDirectoryPath)) {
    throw Object.assign(new Error('Restore bloqueado: arquivo fora de SQLITE_BACKUP_DIRECTORY.'), {
      code: 'RESTORE_PATH_OUTSIDE_BACKUP_DIR',
    });
  }
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
  if (lockStatus.exists && !lockStatus.ownedByCurrentInstance) {
    throw Object.assign(new Error('Restore bloqueado: lock operacional existente indica banco em uso.'), {
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

function assertNoDatabaseSidecars(databasePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecarPath = `${databasePath}${suffix}`;
    if (fs.existsSync(sidecarPath)) {
      throw Object.assign(new Error('Restore bloqueado: arquivo auxiliar SQLite presente.'), {
        code: 'RESTORE_DATABASE_SIDECAR_PRESENT',
        sidecarPath,
      });
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
      } catch {
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
  let rollbackError = null;
  let cleanupError = null;
  let failedRestoredPath = null;

  try {
    assertNoDatabaseSidecars(databasePath);
    fs.copyFileSync(sourceBackupPath, restoreTempPath);
    sqliteBackupService.validateBackup(restoreTempPath);

    assertNoDatabaseSidecars(databasePath);
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
        failedRestoredPath = `${databasePath}.failed-${Date.now()}.sqlite`;
        if (fs.existsSync(databasePath)) {
          fs.renameSync(databasePath, failedRestoredPath);
        }
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
      }
    }

    if (renamedOriginal) {
      try {
        if (!fs.existsSync(databasePath) && fs.existsSync(previousDbPath)) {
          fs.renameSync(previousDbPath, databasePath);
        }
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
      }
    }

    if (!rollbackError && fs.existsSync(restoreTempPath)) {
      try {
        fs.unlinkSync(restoreTempPath);
      } catch (error) {
        cleanupError = error;
      }
    }

    if (rollbackError) {
      const recoveryFiles = [databasePath, previousDbPath, restoreTempPath, failedRestoredPath]
        .filter((filePath) => filePath && fs.existsSync(filePath));
      throw Object.assign(new Error('Restauração falhou e a recuperação automática encontrou erro.'), {
        code: 'RESTORE_ROLLBACK_FAILED',
        cause: rollbackError,
        recoveryFiles,
      });
    }

    if (cleanupError) {
      throw Object.assign(new Error('Rollback concluído, mas o temporário de restore não pôde ser removido.'), {
        code: 'RESTORE_TEMP_CLEANUP_FAILED',
        cause: cleanupError,
        recoveryFiles: fs.existsSync(restoreTempPath) ? [restoreTempPath] : [],
      });
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

  let lockAcquired = false;
  let retainLockForRecovery = false;
  try {
    const resolvedDatabasePath = path.resolve(config.databasePath);
    const backupDirectory = path.resolve(config.sqliteBackupDirectory || './backups');

    const lockResult = sqliteOperationalLockService.acquireLock(resolvedDatabasePath, {
      ownerTag: 'db-restore-cli',
    });
    if (!lockResult.acquired || lockResult.alreadyOwned) {
      throw Object.assign(new Error('Restore bloqueado: não foi possível obter exclusividade do banco.'), {
        code: 'RESTORE_LOCK_ACTIVE',
      });
    }
    lockAcquired = true;

    fs.mkdirSync(backupDirectory, { recursive: true });

    assertNoDatabaseSidecars(resolvedDatabasePath);

    const sourceBackupPath = normalizeInputBackupPath(args.file, backupDirectory);
    if (!fs.existsSync(sourceBackupPath)) {
      throw Object.assign(new Error('Arquivo de backup informado não existe.'), {
        code: 'RESTORE_SOURCE_NOT_FOUND',
      });
    }

    assertRealPathInsideDirectory(sourceBackupPath, backupDirectory);

    if (path.resolve(sourceBackupPath) === resolvedDatabasePath) {
      throw Object.assign(new Error('Restore bloqueado: origem não pode ser o DATABASE_PATH ativo.'), {
        code: 'RESTORE_SOURCE_IS_ACTIVE_DB',
      });
    }

    sqliteBackupService.validateBackup(sourceBackupPath);
    probeDatabaseIsUnused(resolvedDatabasePath);

    const preRestore = await createPreRestoreBackup(resolvedDatabasePath, backupDirectory);
    assertNoDatabaseSidecars(resolvedDatabasePath);
    const restoreResult = restoreAtomically({
      sourceBackupPath,
      databasePath: resolvedDatabasePath,
    });

    try {
      sqliteBackupService.validateBackup(resolvedDatabasePath);
    } catch (validationError) {
      let invalidRestoredPath = null;
      try {
        if (!fs.existsSync(restoreResult.previousDbPath)) {
          throw new Error('Arquivo do banco anterior não está disponível para rollback.');
        }
        if (fs.existsSync(resolvedDatabasePath)) {
          invalidRestoredPath = `${resolvedDatabasePath}.invalid-${Date.now()}.sqlite`;
          fs.renameSync(resolvedDatabasePath, invalidRestoredPath);
        }
        fs.renameSync(restoreResult.previousDbPath, resolvedDatabasePath);
        sqliteBackupService.validateBackup(resolvedDatabasePath);
      } catch {
        const recoveryFiles = [
          resolvedDatabasePath,
          restoreResult.previousDbPath,
          restoreResult.restoreTempPath,
          invalidRestoredPath,
        ].filter((filePath) => filePath && fs.existsSync(filePath));
        throw Object.assign(new Error('Validação final falhou e rollback não pôde ser concluído.'), {
          code: 'RESTORE_ROLLBACK_FAILED',
          recoveryFiles,
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
    if (error.code === 'RESTORE_ROLLBACK_FAILED') {
      retainLockForRecovery = true;
      const recoveryFiles = Array.isArray(error.recoveryFiles) ? error.recoveryFiles : [];
      console.error(
        `Intervenção manual obrigatória: estado do banco não confirmado. Lock operacional mantido. Arquivos de recuperação preservados: ${recoveryFiles.join(', ') || 'verifique manualmente o diretório do banco'}`,
      );
    }
  } finally {
    if (lockAcquired && !retainLockForRecovery) {
      try {
        sqliteOperationalLockService.releaseLock(config.databasePath);
      } catch (error) {
        console.error(`Erro ao liberar lock SQLite. code=${error.code || 'LOCK_REMOVE_FAILED'}`);
        process.exitCode = 1;
      }
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  assertNoDatabaseSidecars,
  normalizeInputBackupPath,
  probeDatabaseIsUnused,
  createPreRestoreBackup,
  restoreAtomically,
};
