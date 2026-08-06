const path = require('path');

function getRequiredEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Variável obrigatória ${key} não definida no arquivo .env.`);
  }
  return value;
}

function parseKickScopes(rawScopes) {
  if (!rawScopes || !rawScopes.trim()) {
    return [];
  }

  return rawScopes
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

const kickClientId = process.env.KICK_CLIENT_ID || null;
const kickClientSecret = process.env.KICK_CLIENT_SECRET || null;

module.exports = {
  databasePath:
    process.env.DATABASE_PATH || path.join(__dirname, '../../data/database.sqlite'),
  discordToken: getRequiredEnv('DISCORD_TOKEN'),
  clientId: process.env.CLIENT_ID,
  guildId: getRequiredEnv('GUILD_ID'),
  subscriberRoleId: process.env.SUBSCRIBER_ROLE_ID || null,
  queueChannelId: process.env.QUEUE_CHANNEL_ID || null,
  queuePanelChannelId: process.env.QUEUE_PANEL_CHANNEL_ID || null,
  kickLinkChannelId: process.env.KICK_LINK_CHANNEL_ID || null,
  queueOpenTime: process.env.QUEUE_OPEN_TIME || '18:58',
  queueCloseTime: process.env.QUEUE_CLOSE_TIME || '06:00',
  queueTimezone: process.env.QUEUE_TIMEZONE || 'America/Sao_Paulo',
  queueTestIntervalMinutes: Number(process.env.QUEUE_TEST_INTERVAL_MINUTES || '5'),
  kickClientId,
  kickClientSecret,
  kickRedirectUri: process.env.KICK_REDIRECT_URI || 'http://localhost:3000/kick/callback',
  kickOauthScopes: parseKickScopes(process.env.KICK_OAUTH_SCOPES || 'user:read events:subscribe'),
  kickPort: parsePositiveInteger(process.env.KICK_PORT || '3000', 3000),
  kickBroadcasterUserId: process.env.KICK_BROADCASTER_USER_ID || null,
  kickEnabled: Boolean(kickClientId && kickClientSecret),
  nodeEnv: process.env.NODE_ENV || 'development',
};
