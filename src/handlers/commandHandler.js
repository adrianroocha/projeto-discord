const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

module.exports = {
  loadCommands(client, config = {}) {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '../commands');
    const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
    const nodeEnv = config.nodeEnv || process.env.NODE_ENV || 'development';
    const isDevelopment = nodeEnv === 'development';

    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      const command = require(filePath);
      if (command.developmentOnly && !isDevelopment) {
        continue;
      }

      if (command.data && command.execute) {
        client.commands.set(command.data.name, command);
      }
    }
  },

  getCommandsData(client) {
    return client.commands.map((command) =>
      typeof command.data.toJSON === 'function' ? command.data.toJSON() : command.data,
    );
  },

  async registerCommands(client, config) {
    const commandsData = this.getCommandsData(client);

    if (config.guildId) {
      const guild = await client.guilds.fetch(config.guildId);
      await guild.commands.set(commandsData);
    } else {
      await client.application.commands.set(commandsData);
    }
  },
};
