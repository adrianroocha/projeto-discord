const path = require('path');

module.exports = {
  databasePath:
    process.env.DATABASE_PATH || path.join(__dirname, '../../data/database.sqlite'),
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  nodeEnv: process.env.NODE_ENV || 'development',
};
