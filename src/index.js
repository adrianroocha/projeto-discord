require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const commandHandler = require('./handlers/commandHandler');
const eventHandler = require('./handlers/eventHandler');
const config = require('./config');
const queueMessageService = require('./services/queueMessageService');
const kickLinkPanelService = require('./services/kickLinkPanelService');
const schedulerService = require('./services/schedulerService');
const subscriberRoleReconciliationScheduler = require('./services/subscriberRoleReconciliationScheduler');
const gracefulShutdownService = require('./services/gracefulShutdownService');
const appBootstrapService = require('./services/appBootstrapService');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});
let schedulerStarted = false;
let subscriberRoleReconciliationSchedulerStarted = false;

commandHandler.loadCommands(client, config);
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

  try {
    if (!subscriberRoleReconciliationSchedulerStarted) {
      subscriberRoleReconciliationSchedulerStarted = true;
      subscriberRoleReconciliationScheduler.start(client);
    }
  } catch (error) {
    console.error('Erro ao iniciar scheduler de reconciliação SUB:', error);
  }
});

client.on('error', (error) => {
  console.error('Erro do client do Discord:', error);
});

client.on('shardError', (error) => {
  console.error('Erro de shard do Discord:', error);
});

gracefulShutdownService.installProcessHandlers({ discordClient: client });

async function start() {
  await appBootstrapService.start(client);
}

start();
