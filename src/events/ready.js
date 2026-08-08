const { Events } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    const startedAt = new Date();
    console.log('Bot pronto:');
    console.log(`  Nome: ${client.user.username}`);
    console.log(`  ID: ${client.user.id}`);
    console.log(`  Servidores: ${client.guilds.cache.size}`);
    console.log(`  Inicializado em: ${startedAt.toISOString()}`);
  },
};
