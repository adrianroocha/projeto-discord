const fs = require('fs');
const path = require('path');

function createStaleThresholdMs() {
  return 6 * 60 * 60 * 1000;
}

function normalizeDbPath(databasePath) {
  if (typeof databasePath !== 'string' || !databasePath.trim()) {
    throw new Error('DATABASE_PATH inválido para lock operacional.');
  }
  return path.resolve(databasePath);
}

function lockPathFromDatabasePath(databasePath) {
  const absoluteDbPath = normalizeDbPath(databasePath);
  return `${absoluteDbPath}.lock`;
}

function safeReadJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (_error) {
    return null;
  }
}

function isPidProbablyRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function isStaleTimestamp(createdAtMs, staleThresholdMs) {
  const value = Number(createdAtMs);
  if (!Number.isFinite(value) || value <= 0) {
    return true;
  }
  return Date.now() - Math.trunc(value) > staleThresholdMs;
}

function createLockPayload(databasePath, ownerTag) {
  return {
    pid: process.pid,
    createdAtMs: Date.now(),
    ownerTag: ownerTag || 'main-process',
    databasePath: normalizeDbPath(databasePath),
  };
}

function writeLockFile(lockFilePath, payload) {
  const serialized = `${JSON.stringify(payload)}\n`;
  fs.writeFileSync(lockFilePath, serialized, { encoding: 'utf8', flag: 'wx' });
}

function acquireLock(databasePath, options = {}) {
  const lockFilePath = lockPathFromDatabasePath(databasePath);
  const staleThresholdMs = Number(options.staleThresholdMs) || createStaleThresholdMs();
  const payload = createLockPayload(databasePath, options.ownerTag);

  fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });

  try {
    writeLockFile(lockFilePath, payload);
    return {
      acquired: true,
      lockFilePath,
      staleRemoved: false,
    };
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      const failure = new Error('Falha ao criar lock operacional do SQLite.');
      failure.code = error && error.code ? error.code : 'LOCK_CREATE_FAILED';
      throw failure;
    }
  }

  const existing = safeReadJson(lockFilePath);
  const pidRunning = isPidProbablyRunning(Number(existing && existing.pid));
  const stale = isStaleTimestamp(existing && existing.createdAtMs, staleThresholdMs);

  if (!pidRunning && stale) {
    try {
      fs.unlinkSync(lockFilePath);
      writeLockFile(lockFilePath, payload);
      return {
        acquired: true,
        lockFilePath,
        staleRemoved: true,
      };
    } catch (error) {
      const failure = new Error('Falha ao recuperar lock operacional obsoleto do SQLite.');
      failure.code = error && error.code ? error.code : 'LOCK_STALE_RECOVERY_FAILED';
      throw failure;
    }
  }

  return {
    acquired: false,
    lockFilePath,
    staleRemoved: false,
    active: pidRunning,
    lockData: existing,
  };
}

function releaseLock(databasePath) {
  const lockFilePath = lockPathFromDatabasePath(databasePath);
  try {
    if (fs.existsSync(lockFilePath)) {
      fs.unlinkSync(lockFilePath);
    }
  } catch (error) {
    const failure = new Error('Falha ao remover lock operacional do SQLite.');
    failure.code = error && error.code ? error.code : 'LOCK_REMOVE_FAILED';
    throw failure;
  }

  return {
    released: true,
    lockFilePath,
  };
}

function inspectLock(databasePath) {
  const lockFilePath = lockPathFromDatabasePath(databasePath);
  if (!fs.existsSync(lockFilePath)) {
    return {
      exists: false,
      lockFilePath,
      active: false,
      stale: false,
      lockData: null,
    };
  }

  const lockData = safeReadJson(lockFilePath);
  const active = isPidProbablyRunning(Number(lockData && lockData.pid));
  const stale = !active && isStaleTimestamp(lockData && lockData.createdAtMs, createStaleThresholdMs());

  return {
    exists: true,
    lockFilePath,
    active,
    stale,
    lockData,
  };
}

module.exports = {
  lockPathFromDatabasePath,
  acquireLock,
  releaseLock,
  inspectLock,
  isPidProbablyRunning,
};
