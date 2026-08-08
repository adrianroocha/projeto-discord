const Database = require('better-sqlite3');
const { databasePath } = require('../config');
const lifecycleService = require('../services/applicationLifecycleService');

let db = null;
let closePromise = null;

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
      db = new Database(databasePath, { readonly: false, fileMustExist: false });
      resolve(db);
    } catch (err) {
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
};
