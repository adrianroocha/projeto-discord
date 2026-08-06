require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const commandHandler = require('./handlers/commandHandler');
const eventHandler = require('./handlers/eventHandler');
const config = require('./config');
const database = require('./database/database');
const queueMessageService = require('./services/queueMessageService');
const kickLinkPanelService = require('./services/kickLinkPanelService');
const schedulerService = require('./services/schedulerService');
const { startKickHttpServer } = require('./services/kickHttpServer');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let schedulerStarted = false;

commandHandler.loadCommands(client);
eventHandler.loadEvents(client);

client.once('ready', async () => {
  try {
    await commandHandler.registerCommands(client, config);
    console.log('Slash commands registrados no Discord.');
  } catch (error) {
    console.error('Erro ao registrar Slash Commands:', error);
  }

  try {
    await queueMessageService.initPanel(client);
    console.log('Painel de fila inicializado.');
  } catch (error) {
    console.error('Erro ao inicializar painel de fila:', error);
  }

  try {
    const result = await kickLinkPanelService.initPanel(client);
    if (result && result.enabled) {
      console.log('Painel de vínculo Kick inicializado.');
    }
  } catch (error) {
    console.error('Erro ao inicializar painel de vínculo Kick:', error);
  }

  try {
    if (!schedulerStarted) {
      schedulerStarted = true;
      schedulerService.startScheduler(client);
    }
  } catch (error) {
    console.error('Erro ao iniciar scheduler:', error);
  }
});

client.on('error', (error) => {
  console.error('Erro do client do Discord:', error);
});

client.on('shardError', (error) => {
  console.error('Erro de shard do Discord:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Erro não capturado:', error);
  process.exit(1);
});

async function start() {
  try {
    await database.initDatabase();
    console.log('Banco de dados inicializado em', config.databasePath);

    try {
      const kickServer = await startKickHttpServer();
      if (kickServer.started) {
        console.log(`Servidor local da Kick ativo na porta ${kickServer.port}.`);
      }
    } catch (kickServerError) {
      console.error('Falha ao iniciar servidor local da Kick (seguindo sem integração Kick):', kickServerError.message);
    }

    console.log('Iniciando o bot do Discord...');
    await client.login(config.discordToken);
  } catch (error) {
    console.error('Erro ao iniciar o bot:', error);
    process.exit(1);
  }
}

start();
