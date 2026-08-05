const fs = require('fs');
const path = require('path');
const { Collection } = require('discord.js');

module.exports = {
  loadCommands(client) {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '../commands');
    const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));

    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      const command = require(filePath);
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
