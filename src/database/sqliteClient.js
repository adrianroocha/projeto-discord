const Database = require('better-sqlite3');
const { databasePath } = require('../config');

let db = null;

function openConnection() {
  return new Promise((resolve, reject) => {
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

function getDatabase() {
  if (!db) {
    throw new Error('Conexão SQLite não aberta.');
  }
  return db;
}

module.exports = {
  openConnection,
  closeConnection,
  getDatabase,
  databasePath,
};
