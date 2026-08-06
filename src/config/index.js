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
  queuePanelChannelId: process.env.QUEUE_PANEL_CHANNEL_ID || null,
  queueOpenTime: process.env.QUEUE_OPEN_TIME || '18:58',
  queueCloseTime: process.env.QUEUE_CLOSE_TIME || '06:00',
  queueTimezone: process.env.QUEUE_TIMEZONE || 'America/Sao_Paulo',
  queueTestIntervalMinutes: Number(process.env.QUEUE_TEST_INTERVAL_MINUTES || '5'),
  nodeEnv: process.env.NODE_ENV || 'development',
};
