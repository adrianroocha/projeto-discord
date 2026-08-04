require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
const fs = require('fs');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Erro: variável DISCORD_TOKEN não definida no arquivo .env.');
  console.error('Copie .env.example para .env e informe seu token do Discord.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const readyEventPath = path.join(__dirname, 'events', 'ready.js');
if (!fs.existsSync(readyEventPath)) {
  console.error('Erro: arquivo de evento ready não encontrado em src/events/ready.js');
  process.exit(1);
}

const readyEvent = require(readyEventPath);
if (readyEvent.once) {
  client.once(readyEvent.name, (...args) => readyEvent.execute(...args));
} else {
  client.on(readyEvent.name, (...args) => readyEvent.execute(...args));
}

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
client.login(token).catch((error) => {
  console.error('Falha ao fazer login no Discord. Verifique o token e a conexão.');
  console.error(error);
  process.exit(1);
});
