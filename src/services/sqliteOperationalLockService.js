const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCK_SCHEMA_VERSION = 2;
const DEFAULT_STALE_THRESHOLD_MS = 120000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const instanceToken = crypto.randomBytes(16).toString('hex');
const heartbeatTimers = new Map();

function createStaleThresholdMs() {
  return DEFAULT_STALE_THRESHOLD_MS;
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

function safeWriteJson(filePath, payload, options = {}) {
  const serialized = `${JSON.stringify(payload)}\n`;
  fs.writeFileSync(filePath, serialized, {
    encoding: 'utf8',
    flag: options.exclusive ? 'wx' : 'w',
  });
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

function toSafeTimestampMs(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function isPayloadOwnedByCurrentInstance(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  return payload.instanceToken === instanceToken;
}

function readOptionalEnvString(name) {
  const value = process.env[name];
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function getRailwayRuntimeMetadata() {
  return {
    deploymentId: readOptionalEnvString('RAILWAY_DEPLOYMENT_ID'),
    replicaId: readOptionalEnvString('RAILWAY_REPLICA_ID'),
  };
}

function canRecoverImmediatelyByRailwayDeployment(existingPayload) {
  const runtimeMetadata = getRailwayRuntimeMetadata();
  const currentDeploymentId = runtimeMetadata.deploymentId;
  const existingDeploymentId =
    typeof existingPayload?.railwayDeploymentId === 'string'
      ? existingPayload.railwayDeploymentId.trim() || null
      : null;

  if (!currentDeploymentId || !existingDeploymentId) {
    return false;
  }

  // Railway volume-backed deploys do not keep two different deployment IDs active
  // on the same persistent mount simultaneously. A differing deployment ID means
  // the previous holder is from an older deployment and can be safely replaced.
  return currentDeploymentId !== existingDeploymentId;
}

function getObservedTimestamp(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return (
    toSafeTimestampMs(payload.updatedAtMs) ||
    toSafeTimestampMs(payload.heartbeatAtMs) ||
    toSafeTimestampMs(payload.createdAtMs)
  );
}

function createLockPayload(databasePath, ownerTag) {
  const nowMs = Date.now();
  const runtimeMetadata = getRailwayRuntimeMetadata();
  return {
    version: LOCK_SCHEMA_VERSION,
    instanceToken,
    pid: process.pid,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    ownerTag: ownerTag || 'main-process',
    databasePath: normalizeDbPath(databasePath),
    railwayDeploymentId: runtimeMetadata.deploymentId,
    railwayReplicaId: runtimeMetadata.replicaId,
  };
}

function writeLockFile(lockFilePath, payload) {
  safeWriteJson(lockFilePath, payload, { exclusive: true });
}

function refreshLock(databasePath) {
  const lockFilePath = lockPathFromDatabasePath(databasePath);
  if (!fs.existsSync(lockFilePath)) {
    return { refreshed: false, lockFilePath, reason: 'missing' };
  }

  const payload = safeReadJson(lockFilePath);
  if (!isPayloadOwnedByCurrentInstance(payload)) {
    return { refreshed: false, lockFilePath, reason: 'not_owned' };
  }

  const nextPayload = {
    ...payload,
    updatedAtMs: Date.now(),
  };

  safeWriteJson(lockFilePath, nextPayload, { exclusive: false });
  return { refreshed: true, lockFilePath };
}

function stopHeartbeat(databasePath) {
  const absoluteDbPath = normalizeDbPath(databasePath);
  const timer = heartbeatTimers.get(absoluteDbPath);
  if (!timer) {
    return { stopped: false };
  }

  clearInterval(timer);
  heartbeatTimers.delete(absoluteDbPath);
  return { stopped: true };
}

function startHeartbeat(databasePath, options = {}) {
  if (process.env.JEST_WORKER_ID) {
    return { started: false, reason: 'test_env' };
  }

  const absoluteDbPath = normalizeDbPath(databasePath);
  const intervalMs = Number(options.heartbeatIntervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS;
  stopHeartbeat(absoluteDbPath);

  const timer = setInterval(() => {
    try {
      refreshLock(absoluteDbPath);
    } catch (_error) {
      // best-effort: lock freshness update must not crash the app.
    }
  }, Math.max(1000, intervalMs));

  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  heartbeatTimers.set(absoluteDbPath, timer);
  return { started: true, intervalMs: Math.max(1000, intervalMs) };
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
  const observedTimestampMs = getObservedTimestamp(existing);
  const stale = isStaleTimestamp(observedTimestampMs, staleThresholdMs);

  if (isPayloadOwnedByCurrentInstance(existing)) {
    return {
      acquired: true,
      lockFilePath,
      staleRemoved: false,
      alreadyOwned: true,
    };
  }

  if (canRecoverImmediatelyByRailwayDeployment(existing)) {
    try {
      fs.unlinkSync(lockFilePath);
      writeLockFile(lockFilePath, payload);
      return {
        acquired: true,
        lockFilePath,
        staleRemoved: true,
        recoveredByRailwayDeployment: true,
        previousOwner: existing,
      };
    } catch (error) {
      const failure = new Error('Falha ao recuperar lock operacional de deployment Railway anterior.');
      failure.code = error && error.code ? error.code : 'LOCK_RAILWAY_DEPLOYMENT_RECOVERY_FAILED';
      throw failure;
    }
  }

  if (stale) {
    try {
      fs.unlinkSync(lockFilePath);
      writeLockFile(lockFilePath, payload);
      return {
        acquired: true,
        lockFilePath,
        staleRemoved: true,
        previousOwner: existing,
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
    active: !stale && pidRunning,
    lockData: existing,
  };
}

function releaseLock(databasePath) {
  const lockFilePath = lockPathFromDatabasePath(databasePath);
  stopHeartbeat(databasePath);

  try {
    if (!fs.existsSync(lockFilePath)) {
      return {
        released: true,
        lockFilePath,
        missing: true,
      };
    }

    const existing = safeReadJson(lockFilePath);
    if (!isPayloadOwnedByCurrentInstance(existing)) {
      const notOwnedError = new Error('Lock operacional pertence a outra instância ativa.');
      notOwnedError.code = 'LOCK_NOT_OWNED';
      throw notOwnedError;
    }

    fs.unlinkSync(lockFilePath);
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
  const activeByToken = isPayloadOwnedByCurrentInstance(lockData);
  const pidRunning = isPidProbablyRunning(Number(lockData && lockData.pid));
  const observedTimestampMs = getObservedTimestamp(lockData);
  const stale = isStaleTimestamp(observedTimestampMs, createStaleThresholdMs());
  const active = activeByToken || (!stale && pidRunning);

  return {
    exists: true,
    lockFilePath,
    active,
    stale,
    ownedByCurrentInstance: activeByToken,
    lockData,
  };
}

module.exports = {
  lockPathFromDatabasePath,
  getHeartbeatIntervalMs: () => DEFAULT_HEARTBEAT_INTERVAL_MS,
  getStaleThresholdMs: () => DEFAULT_STALE_THRESHOLD_MS,
  getInstanceToken: () => instanceToken,
  acquireLock,
  refreshLock,
  startHeartbeat,
  stopHeartbeat,
  releaseLock,
  inspectLock,
  isPidProbablyRunning,
};
