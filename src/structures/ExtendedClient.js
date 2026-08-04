const { Client, GatewayIntentBits, Collection } = require('discord.js');

class ExtendedClient extends Client {
  constructor(options = {}) {
    super({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      ...options,
    });

    this.commands = new Collection();
  }
}

module.exports = ExtendedClient;
