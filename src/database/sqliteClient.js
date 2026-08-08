const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { databasePath } = require('../config');
const lifecycleService = require('../services/applicationLifecycleService');
const sqliteOperationalLockService = require('../services/sqliteOperationalLockService');

let db = null;
let closePromise = null;
let lockHeld = false;

function openConnection() {
  return new Promise((resolve, reject) => {
    if (lifecycleService.isShuttingDown()) {
      reject(new Error('Aplicação em shutdown: nova conexão SQLite bloqueada.'));
      return;
    }

    if (db) {
      return resolve(db);
    }

    try {
      fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

      const lockResult = sqliteOperationalLockService.acquireLock(databasePath, {
        ownerTag: 'discord-bot-main',
      });

      if (!lockResult.acquired) {
        const lockError = new Error('Banco SQLite em uso por outra instância.');
        lockError.code = 'SQLITE_DB_LOCK_ACTIVE';
        reject(lockError);
        return;
      }

      lockHeld = true;
      sqliteOperationalLockService.startHeartbeat(databasePath);
      db = new Database(databasePath, { readonly: false, fileMustExist: false });
      resolve(db);
    } catch (err) {
      if (lockHeld) {
        try {
          sqliteOperationalLockService.releaseLock(databasePath);
        } catch (_releaseError) {
          // no-op: lock cleanup best effort during failed open
        }
      }
      lockHeld = false;
      db = null;
      reject(err);
    }
  });
}

function closeConnection() {
  if (closePromise) {
    return closePromise;
  }

  return new Promise((resolve, reject) => {
    if (!db) {
      return resolve();
    }

    try {
      db.close();
      db = null;
      if (lockHeld) {
        sqliteOperationalLockService.stopHeartbeat(databasePath);
        sqliteOperationalLockService.releaseLock(databasePath);
      }
      lockHeld = false;
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function closeConnectionSafe() {
  closePromise = closeConnection()
    .catch((error) => {
      throw error;
    })
    .finally(() => {
      closePromise = null;
    });

  return closePromise;
}

function getDatabase() {
  if (!db) {
    throw new Error('Conexão SQLite não aberta.');
  }
  return db;
}

module.exports = {
  openConnection,
  closeConnection: closeConnectionSafe,
  getDatabase,
  databasePath,
  isConnectionOpen: () => Boolean(db),
  getDatabasePath: () => databasePath,
  releaseOperationalLock: () => sqliteOperationalLockService.releaseLock(databasePath),
  inspectOperationalLock: () => sqliteOperationalLockService.inspectLock(databasePath),
};
