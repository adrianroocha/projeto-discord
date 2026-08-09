const config = require('../config');
const { Events } = require('discord.js');
const database = require('../database/database');
const commandHandler = require('../handlers/commandHandler');
const { startKickHttpServer } = require('./kickHttpServer');
const queueMessageService = require('./queueMessageService');
const kickLinkPanelService = require('./kickLinkPanelService');
const schedulerService = require('./schedulerService');
const sqliteBackupScheduler = require('./sqliteBackupScheduler');
const subscriberRoleReconciliationScheduler = require('./subscriberRoleReconciliationScheduler');
const adminAuditRetentionScheduler = require('./adminAuditRetentionScheduler');
const lifecycleService = require('./applicationLifecycleService');
const gracefulShutdownService = require('./gracefulShutdownService');

function waitForDiscordReady(discordClient) {
  if (discordClient && discordClient.isReady && discordClient.isReady()) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    function onReady() {
      cleanup();
      resolve();
    }

    function onError(error) {
      cleanup();
      reject(error || new Error('Discord client error during startup.'));
    }

    function cleanup() {
      discordClient.removeListener(Events.ClientReady, onReady);
      discordClient.removeListener('error', onError);
      discordClient.removeListener('shardError', onError);
    }

    discordClient.once(Events.ClientReady, onReady);
    discordClient.once('error', onError);
    discordClient.once('shardError', onError);
  });
}

function createAppBootstrapService(options = {}) {
  const cfg = options.config || config;
  const db = options.database || database;
  const commands = options.commandHandler || commandHandler;
  const kickHttpServerStarter = options.startKickHttpServer || startKickHttpServer;
  const queuePanel = options.queueMessageService || queueMessageService;
  const kickPanel = options.kickLinkPanelService || kickLinkPanelService;
  const queueScheduler = options.schedulerService || schedulerService;
  const backupScheduler = options.sqliteBackupScheduler || sqliteBackupScheduler;
  const subReconciliationScheduler =
    options.subscriberRoleReconciliationScheduler || subscriberRoleReconciliationScheduler;
  const adminAuditRetention = options.adminAuditRetentionScheduler || adminAuditRetentionScheduler;
  const lifecycle = options.lifecycleService || lifecycleService;
  const shutdownService = options.gracefulShutdownService || gracefulShutdownService;
  const logger = options.logger || console;

  async function start(discordClient) {
    try {
      await db.initDatabase();
      if (typeof logger?.info === 'function') {
        logger.info(`Banco de dados inicializado em ${cfg.databasePath}`);
      }

      await adminAuditRetention.start();

      const kickServer = await kickHttpServerStarter({ discordClient });
      if (kickServer.started && typeof logger?.info === 'function') {
        logger.info(`Servidor HTTP da Kick ativo em ${kickServer.host}:${kickServer.port}.`);
      }

      if (typeof logger?.info === 'function') {
        logger.info('Iniciando o bot do Discord...');
      }

      await discordClient.login(cfg.discordToken);
      await waitForDiscordReady(discordClient);

      await commands.registerCommands(discordClient, cfg);
      if (typeof logger?.info === 'function') {
        logger.info('Slash commands registrados no Discord.');
      }

      const queuePanelResult = await queuePanel.initPanel(discordClient);
      if (queuePanelResult && queuePanelResult.code === 'CHANNEL_ACCESS_DENIED') {
        if (typeof logger?.warn === 'function') {
          logger.warn('Painel de fila não inicializado: permissões insuficientes no canal. code=CHANNEL_ACCESS_DENIED');
        }
      } else if (typeof logger?.info === 'function') {
        logger.info('Painel de fila inicializado.');
      }

      const kickPanelResult = await kickPanel.initPanel(discordClient);
      if (kickPanelResult && kickPanelResult.code === 'CHANNEL_ACCESS_DENIED') {
        if (typeof logger?.warn === 'function') {
          logger.warn('Painel de vínculo Kick não inicializado: permissões insuficientes no canal. code=CHANNEL_ACCESS_DENIED');
        }
      } else if (kickPanelResult && kickPanelResult.enabled && typeof logger?.info === 'function') {
        logger.info('Painel de vínculo Kick inicializado.');
      }

      queueScheduler.startScheduler(discordClient);
      backupScheduler.start();
      subReconciliationScheduler.start(discordClient);

      lifecycle.markReady();
      return { started: true };
    } catch (error) {
      lifecycle.markFailed('startup_failure');

      if (typeof logger?.error === 'function') {
        logger.error(`Erro ao iniciar o bot. code=${error?.code || error?.name || 'APP_START_FAILED'}`);
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
