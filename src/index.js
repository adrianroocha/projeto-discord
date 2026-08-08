require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const commandHandler = require('./handlers/commandHandler');
const eventHandler = require('./handlers/eventHandler');
const config = require('./config');
const gracefulShutdownService = require('./services/gracefulShutdownService');
const appBootstrapService = require('./services/appBootstrapService');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

commandHandler.loadCommands(client, config);
eventHandler.loadEvents(client);

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
