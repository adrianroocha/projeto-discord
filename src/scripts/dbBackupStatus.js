require('dotenv').config();

const database = require('../database/database');
const sqliteClient = require('../database/sqliteClient');
const sqliteBackupService = require('../services/sqliteBackupService');

function formatDate(valueMs) {
  if (!Number.isFinite(Number(valueMs))) {
    return '-';
  }

  return new Date(Number(valueMs)).toISOString();
}

function normalizeSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return '-';
  }
  return String(Math.trunc(parsed));
}

async function main() {
  let exitCode = 1;

  try {
    await database.initDatabase();

    const runs = sqliteBackupService.getLatestRuns(50);
    const files = sqliteBackupService.listBackupFiles();

    const byFileName = new Map();
    for (const run of runs) {
      if (run.file_name && !byFileName.has(run.file_name)) {
        byFileName.set(run.file_name, run);
      }
    }

    if (!files.length) {
      console.log('Nenhum backup encontrado.');
      exitCode = 0;
      return;
    }

    console.log('Backups disponíveis (metadados seguros):');
    for (const file of files) {
      const run = byFileName.get(file.fileName);
      const integrity = run ? run.integrity_result : 'desconhecido';
      const result = run ? run.result : 'desconhecido';
      const when = run ? formatDate(run.finished_at_ms) : formatDate(file.mtimeMs);
      console.log(
        `- data=${when} nome=${file.fileName} tamanho=${normalizeSize(
          file.sizeBytes,
        )}B integridade=${integrity} resultado=${result}`,
      );
    }

    exitCode = 0;
  } catch (error) {
    console.error(`Erro ao listar status de backups. code=${error.code || error.name || 'DB_BACKUP_STATUS_FAILED'}`);
    exitCode = 1;
  } finally {
    try {
      await sqliteClient.closeConnection();
    } catch (_error) {
      exitCode = 1;
    }

    process.exitCode = exitCode;
  }
}

main();
