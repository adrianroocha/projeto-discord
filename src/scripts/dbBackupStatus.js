require('dotenv').config();

const sqliteBackupService = require('../services/sqliteBackupService');

async function main() {
  let exitCode = 1;

  try {
    const files = sqliteBackupService.listBackupFiles();

    if (!files.length) {
      console.log('Nenhum backup encontrado.');
      console.log('Auditoria de execuções indisponível: o banco ativo não foi aberto.');
      exitCode = 0;
      return;
    }

    console.log('Backups disponíveis (metadados seguros):');
    console.log('Auditoria de execuções indisponível: o banco ativo não foi aberto.');
    for (const file of files) {
      let integrity = 'falhou';
      try {
        sqliteBackupService.validateBackup(file.path);
        integrity = 'ok';
      } catch (error) {
        integrity = `falhou(${error.code || error.name || 'VALIDATION_FAILED'})`;
      }

      console.log(
        `- data=${new Date(file.mtimeMs).toISOString()} nome=${file.fileName} tamanho=${Math.trunc(
          file.sizeBytes,
        )}B integridade=${integrity}`,
      );
    }

    exitCode = 0;
  } catch (error) {
    console.error(`Erro ao listar status de backups. code=${error.code || error.name || 'DB_BACKUP_STATUS_FAILED'}`);
    exitCode = 1;
  } finally {
    process.exitCode = exitCode;
  }
}

main();
