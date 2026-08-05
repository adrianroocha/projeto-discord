require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const commandHandler = require('./handlers/commandHandler');
const eventHandler = require('./handlers/eventHandler');
const config = require('./config');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

commandHandler.loadCommands(client);
eventHandler.loadEvents(client);

client.once('clientReady', async () => {
  try {
    await commandHandler.registerCommands(client, config);
    console.log('Slash commands registrados no Discord.');
  } catch (error) {
    console.error('Erro ao registrar os Slash Commands:', error);
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

console.log('Iniciando o bot do Discord...');
client.login(config.discordToken).catch((error) => {
  console.error('Falha ao fazer login no Discord. Verifique o token e a conexão.');
  console.error(error);
  process.exit(1);
});
