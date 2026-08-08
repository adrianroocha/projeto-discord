const config = require('../config');
const database = require('../database/database');
const { startKickHttpServer } = require('./kickHttpServer');
const gracefulShutdownService = require('./gracefulShutdownService');

function createAppBootstrapService(options = {}) {
  const cfg = options.config || config;
  const db = options.database || database;
  const kickHttpServerStarter = options.startKickHttpServer || startKickHttpServer;
  const shutdownService = options.gracefulShutdownService || gracefulShutdownService;
  const logger = options.logger || console;

  async function start(discordClient) {
    try {
      await db.initDatabase();
      if (typeof logger?.info === 'function') {
        logger.info(`Banco de dados inicializado em ${cfg.databasePath}`);
      }

      try {
        const kickServer = await kickHttpServerStarter({ discordClient });
        if (kickServer.started && typeof logger?.info === 'function') {
          logger.info(`Servidor local da Kick ativo na porta ${kickServer.port}.`);
        }
      } catch (kickServerError) {
        if (typeof logger?.error === 'function') {
          logger.error(
            `Falha ao iniciar servidor local da Kick (seguindo sem integração Kick): ${kickServerError.message}`,
          );
        }
      }

      if (typeof logger?.info === 'function') {
        logger.info('Iniciando o bot do Discord...');
      }

      await discordClient.login(cfg.discordToken);
      return { started: true };
    } catch (_error) {
      if (typeof logger?.error === 'function') {
        logger.error('Erro ao iniciar o bot.');
      }

      await shutdownService.shutdown({
        reason: 'startup_failure',
        fatal: true,
        discordClient,
      });

      return { started: false };
    }
  }

  return {
    start,
  };
}

const defaultService = createAppBootstrapService();
defaultService.createAppBootstrapService = createAppBootstrapService;

module.exports = defaultService;
