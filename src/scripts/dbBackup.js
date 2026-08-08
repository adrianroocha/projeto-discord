require('dotenv').config();

const database = require('../database/database');
const sqliteClient = require('../database/sqliteClient');
const sqliteBackupService = require('../services/sqliteBackupService');

async function main() {
  let exitCode = 1;

  try {
    await database.initDatabase();

    const backupResult = await sqliteBackupService.createBackup({ triggerType: 'cli_manual' });
    if (!backupResult.success) {
      console.error(`Backup falhou. code=${backupResult.errorCode || 'BACKUP_FAILED'}`);
      process.exitCode = 1;
      return;
    }

    const validation = sqliteBackupService.validateBackup(backupResult.path);
    if (!validation.success) {
      console.error('Validação de integridade do backup falhou.');
      process.exitCode = 1;
      return;
    }

    try {
      const retention = sqliteBackupService.cleanupRetention();
      console.log(
        `Retenção aplicada. removidos=${retention.removedCount} verificados=${retention.scannedCount}`,
      );
    } catch (retentionError) {
      console.warn(`Aviso: retenção falhou code=${retentionError.code || 'RETENTION_FAILED'}`);
    }

    console.log(`Backup concluído: ${backupResult.fileName}`);
    console.log(`Path: ${backupResult.path}`);
    console.log(`Size: ${backupResult.sizeBytes} bytes`);
    console.log(`Integrity: ${backupResult.integrityResult}`);
    exitCode = 0;
  } catch (error) {
    console.error(`Erro no backup manual. code=${error.code || error.name || 'DB_BACKUP_CLI_FAILED'}`);
    exitCode = 1;
  } finally {
    try {
      await sqliteClient.closeConnection();
    } catch (closeError) {
      console.error(`Erro ao fechar SQLite. code=${closeError.code || 'SQLITE_CLOSE_FAILED'}`);
      exitCode = 1;
    }

    process.exitCode = exitCode;
  }
}

main();
