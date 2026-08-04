const sqlite3 = require('sqlite3').verbose();
const { databasePath } = require('../config');

const db = new sqlite3.Database(
  databasePath,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) {
      console.error('Erro ao conectar ao SQLite:', err);
      return;
    }
    console.log('Conectado ao SQLite em', databasePath);
  }
);

module.exports = db;
