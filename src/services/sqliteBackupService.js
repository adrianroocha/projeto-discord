const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const config = require('../config');
const sqliteClient = require('../database/sqliteClient');
const sqliteBackupRunsRepository = require('../database/sqliteBackupRunsRepository');

const BACKUP_FILE_NAME_PATTERN = /^database-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.sqlite$/;

function nowMs() {
  return Date.now();
}

function createErrorCode(error, fallback = 'unknown_error') {
  if (error && typeof error === 'object') {
    if (typeof error.code === 'string' && error.code.trim()) {
      return error.code.trim();
    }
    if (typeof error.name === 'string' && error.name.trim()) {
      return error.name.trim();
    }
  }
  return fallback;
}

function normalizeDirectoryPath(rawDirectory) {
  if (typeof rawDirectory !== 'string' || !rawDirectory.trim()) {
    throw Object.assign(new Error('SQLITE_BACKUP_DIRECTORY inválido.'), { code: 'INVALID_BACKUP_DIRECTORY' });
  }

  return path.resolve(rawDirectory);
}

function normalizeDatabasePath(rawDatabasePath) {
  if (typeof rawDatabasePath !== 'string' || !rawDatabasePath.trim()) {
    throw Object.assign(new Error('DATABASE_PATH inválido.'), { code: 'INVALID_DATABASE_PATH' });
  }

  return path.resolve(rawDatabasePath);
}

function ensureInsideDirectory(filePath, directoryPath) {
  const absoluteFilePath = path.resolve(filePath);
  const absoluteDirectoryPath = path.resolve(directoryPath);
  const relative = path.relative(absoluteDirectoryPath, absoluteFilePath);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return true;
  }
  return false;
}

function formatDatePart(value, width) {
  return String(value).padStart(width, '0');
}

function buildTimestampedBackupName(dateValue = new Date()) {
  const year = formatDatePart(dateValue.getFullYear(), 4);
  const month = formatDatePart(dateValue.getMonth() + 1, 2);
  const day = formatDatePart(dateValue.getDate(), 2);
  const hour = formatDatePart(dateValue.getHours(), 2);
  const minute = formatDatePart(dateValue.getMinutes(), 2);
  const second = formatDatePart(dateValue.getSeconds(), 2);
  return `database-${year}-${month}-${day}_${hour}-${minute}-${second}.sqlite`;
}

function getSafeFileSizeBytes(filePath) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw Object.assign(new Error('Arquivo de backup inválido.'), { code: 'INVALID_BACKUP_FILE' });
  }
  if (!Number.isFinite(stats.size) || stats.size <= 0) {
    throw Object.assign(new Error('Arquivo de backup vazio.'), { code: 'EMPTY_BACKUP_FILE' });
  }
  return stats.size;
}

function validateBackup(filePath) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw Object.assign(new Error('Arquivo de backup não encontrado.'), { code: 'BACKUP_NOT_FOUND' });
  }

  getSafeFileSizeBytes(absolutePath);

  let validationDb;
  try {
    validationDb = new Database(absolutePath, { readonly: true, fileMustExist: true });
    const resultRow = validationDb.pragma('integrity_check', { simple: true });
    const integrityResult = String(resultRow || '').trim().toLowerCase();
    if (integrityResult !== 'ok') {
      throw Object.assign(new Error('PRAGMA integrity_check falhou.'), {
        code: 'BACKUP_INTEGRITY_FAILED',
        integrityResult,
      });
    }

    return {
      success: true,
      integrityResult: 'ok',
      sizeBytes: getSafeFileSizeBytes(absolutePath),
      path: absolutePath,
    };
  } finally {
    if (validationDb) {
      validationDb.close();
    }
  }
}

function createSqliteBackupService(options = {}) {
  const cfg = options.config || config;
  const logger = options.logger || console;
  const sqlite = options.sqliteClient || sqliteClient;
  const backupRunsRepository = options.sqliteBackupRunsRepository || sqliteBackupRunsRepository;
  const nowFn = options.now || nowMs;

  let activeBackupPromise = null;
  let activeTempPath = null;

  function getResolvedBackupDirectory() {
    const backupDirectory = normalizeDirectoryPath(cfg.sqliteBackupDirectory || './backups');
    const dbPath = normalizeDatabasePath(cfg.databasePath || sqlite.databasePath);

    if (backupDirectory === dbPath) {
      throw Object.assign(new Error('SQLITE_BACKUP_DIRECTORY não pode apontar para o arquivo do banco.'), {
        code: 'BACKUP_DIRECTORY_EQUALS_DB_FILE',
      });
    }

    return {
      backupDirectory,
      dbPath,
    };
  }

  function listBackupFiles() {
    const { backupDirectory } = getResolvedBackupDirectory();
    if (!fs.existsSync(backupDirectory)) {
      return [];
    }

    const items = fs.readdirSync(backupDirectory, { withFileTypes: true });
    return items
      .filter((entry) => entry.isFile())
      .filter((entry) => BACKUP_FILE_NAME_PATTERN.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(backupDirectory, entry.name);
        const stats = fs.statSync(fullPath);
        return {
          fileName: entry.name,
          path: fullPath,
          mtimeMs: Number(stats.mtimeMs) || 0,
          sizeBytes: Number(stats.size) || 0,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  function cleanupRetention(retentionDaysInput) {
    const { backupDirectory, dbPath } = getResolvedBackupDirectory();
    const retentionDays = Number(retentionDaysInput ?? cfg.sqliteBackupRetentionDays);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
      throw Object.assign(new Error('SQLITE_BACKUP_RETENTION_DAYS inválido.'), { code: 'INVALID_RETENTION_DAYS' });
    }

    if (!fs.existsSync(backupDirectory)) {
      return { removedCount: 0, scannedCount: 0 };
    }

    const cutoffMs = nowFn() - retentionDays * 24 * 60 * 60 * 1000;
    const entries = fs.readdirSync(backupDirectory, { withFileTypes: true });
    let removedCount = 0;
    let scannedCount = 0;

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!BACKUP_FILE_NAME_PATTERN.test(entry.name)) {
        continue;
      }

      const filePath = path.join(backupDirectory, entry.name);
      if (!ensureInsideDirectory(filePath, backupDirectory)) {
        continue;
      }

      if (path.resolve(filePath) === path.resolve(dbPath)) {
        continue;
      }

      if (activeTempPath && path.resolve(filePath) === path.resolve(activeTempPath)) {
        continue;
      }

      scannedCount += 1;
      const stats = fs.statSync(filePath);
      if ((Number(stats.mtimeMs) || 0) >= cutoffMs) {
        continue;
      }

      fs.unlinkSync(filePath);
      removedCount += 1;
    }

    return { removedCount, scannedCount };
  }

  function recordRun(entry) {
    try {
      backupRunsRepository.saveRun(entry);
    } catch (error) {
      if (typeof logger?.warn === 'function') {
        logger.warn(`SQLite backup audit warning code=${createErrorCode(error)}`);
      }
    }
  }

  async function createBackup(optionsArg = {}) {
    if (activeBackupPromise) {
      const error = Object.assign(new Error('Backup SQLite já está em andamento.'), {
        code: 'BACKUP_ALREADY_RUNNING',
      });
      return {
        success: false,
        startedAtMs: nowFn(),
        finishedAtMs: nowFn(),
        integrityResult: 'not_run',
        result: 'failed',
        errorCode: error.code,
      };
    }

    const options = optionsArg || {};
    const triggerType = String(options.triggerType || 'manual').trim() || 'manual';

    activeBackupPromise = (async () => {
      const startedAtMs = nowFn();
      let finishedAtMs = startedAtMs;
      let tempBackupPath = null;
      let finalBackupPath = null;
      let finalFileName = null;
      let integrityResult = 'not_run';

      try {
        const db = sqlite.getDatabase && sqlite.getDatabase();
        if (!db || typeof db.backup !== 'function') {
          throw Object.assign(new Error('Conexão SQLite indisponível para backup.'), {
            code: 'SQLITE_CONNECTION_NOT_OPEN',
          });
        }

        const { backupDirectory } = getResolvedBackupDirectory();
        fs.mkdirSync(backupDirectory, { recursive: true });

        finalFileName = buildTimestampedBackupName(new Date(startedAtMs));
        finalBackupPath = path.join(backupDirectory, finalFileName);

        const tempSuffix = `${process.pid}-${startedAtMs}`;
        tempBackupPath = path.join(backupDirectory, `.${finalFileName}.${tempSuffix}.tmp`);
        activeTempPath = tempBackupPath;

        await db.backup(tempBackupPath);

        const validation = validateBackup(tempBackupPath);
        integrityResult = validation.integrityResult;

        fs.renameSync(tempBackupPath, finalBackupPath);
        activeTempPath = null;
        tempBackupPath = null;

        const sizeBytes = getSafeFileSizeBytes(finalBackupPath);
        finishedAtMs = nowFn();

        const response = {
          success: true,
          fileName: finalFileName,
          path: finalBackupPath,
          sizeBytes,
          startedAtMs,
          finishedAtMs,
          integrityResult,
          result: 'ok',
          errorCode: null,
        };

        recordRun({
          triggerType,
          startedAtMs,
          finishedAtMs,
          fileName: finalFileName,
          sizeBytes,
          integrityResult,
          result: 'ok',
          errorCode: null,
        });

        return response;
      } catch (error) {
        finishedAtMs = nowFn();

        if (tempBackupPath && fs.existsSync(tempBackupPath)) {
          try {
            fs.unlinkSync(tempBackupPath);
          } catch {
            // no-op
          }
        }

        const safeCode = createErrorCode(error, 'BACKUP_FAILED');
        recordRun({
          triggerType,
          startedAtMs,
          finishedAtMs,
          fileName: finalFileName,
          sizeBytes: null,
          integrityResult,
          result: 'failed',
          errorCode: safeCode,
        });

        return {
          success: false,
          fileName: finalFileName,
          path: finalBackupPath,
          sizeBytes: null,
          startedAtMs,
          finishedAtMs,
          integrityResult,
          result: 'failed',
          errorCode: safeCode,
        };
      } finally {
        activeTempPath = null;
      }
    })();

    try {
      return await activeBackupPromise;
    } finally {
      activeBackupPromise = null;
    }
  }

  function getStatus() {
    return {
      running: Boolean(activeBackupPromise),
      activeTempPath,
      backupDirectory: getResolvedBackupDirectory().backupDirectory,
    };
  }

  async function waitForOngoingBackup(options = {}) {
    const timeoutMs = Math.max(1, Math.trunc(Number(options.timeoutMs) || 1));
    if (!activeBackupPromise) {
      return {
        waited: false,
        completed: true,
        timeout: false,
      };
    }

    let timeoutId;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
      if (timeoutId && typeof timeoutId.unref === 'function') {
        timeoutId.unref();
      }
    });

    const outcome = await Promise.race([
      activeBackupPromise.then(() => 'done').catch(() => 'done'),
      timeoutPromise,
    ]);

    clearTimeout(timeoutId);
    return {
      waited: true,
      completed: outcome === 'done',
      timeout: outcome === 'timeout',
    };
  }

  function getLatestRuns(limit = 20) {
    return backupRunsRepository.listRecent(limit);
  }

  return {
    createBackup,
    validateBackup,
    cleanupRetention,
    listBackupFiles,
    getLatestRuns,
    getStatus,
    waitForOngoingBackup,
    getResolvedBackupDirectory,
    BACKUP_FILE_NAME_PATTERN,
  };
}

const defaultService = createSqliteBackupService();
defaultService.createSqliteBackupService = createSqliteBackupService;
defaultService.validateBackup = validateBackup;
defaultService.BACKUP_FILE_NAME_PATTERN = BACKUP_FILE_NAME_PATTERN;

module.exports = defaultService;
