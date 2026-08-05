const path = require('path');

function getRequiredEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Variável obrigatória ${key} não definida no arquivo .env.`);
  }
  return value;
}

module.exports = {
  databasePath:
    process.env.DATABASE_PATH || path.join(__dirname, '../../data/database.sqlite'),
  discordToken: getRequiredEnv('DISCORD_TOKEN'),
  clientId: process.env.CLIENT_ID,
  guildId: getRequiredEnv('GUILD_ID'),
  subscriberRoleId: process.env.SUBSCRIBER_ROLE_ID || null,
  queueChannelId: process.env.QUEUE_CHANNEL_ID || null,
  lobbyChannelId: process.env.LOBBY_CHANNEL_ID || null,
  queueOpenTime: process.env.QUEUE_OPEN_TIME || null,
  queueCloseTime: process.env.QUEUE_CLOSE_TIME || null,
  nodeEnv: process.env.NODE_ENV || 'development',
};
