const net = require('net');
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

function parsePositiveIntegerWithMax(value, fallback, maxValue) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, maxValue);
}

function parseBoundedPositiveInteger(value, options) {
  const fallback = options.fallback;
  const min = options.min;
  const max = options.max;

  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    return fallback;
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  if (parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return fallback;
}

function parseTimeLabelWithFallback(value, fallback) {
  const normalized = String(value || '').trim();
  const target = normalized || fallback;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(target)) {
    return fallback;
  }
  return target;
}

function parseIanaTimeZone(value, fallback) {
  const normalized = String(value || '').trim() || fallback;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date());
    return normalized;
  } catch (_error) {
    return fallback;
  }
}

function isSafeHostLabel(value) {
  if (!/^[A-Za-z0-9-]+$/.test(value)) {
    return false;
  }

  return !value.startsWith('-') && !value.endsWith('-');
}

function parseHost(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return fallback;
  }

  if (normalized === 'localhost') {
    return normalized;
  }

  if (net.isIP(normalized) !== 0) {
    return normalized;
  }

  if (normalized.length > 253) {
    return fallback;
  }

  const labels = normalized.split('.');
  if (!labels.length || labels.some((label) => !isSafeHostLabel(label))) {
    return fallback;
  }

  return normalized;
}

function parsePortWithPrecedence() {
  const platformPort = parseBoundedPositiveInteger(process.env.PORT, {
    fallback: null,
    min: 1,
    max: 65535,
  });

  if (platformPort !== null) {
    return platformPort;
  }

  const kickPort = parseBoundedPositiveInteger(process.env.KICK_PORT, {
    fallback: 3000,
    min: 1,
    max: 65535,
  });

  return kickPort;
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
  kickHost: parseHost(process.env.KICK_HOST, '127.0.0.1'),
  kickRedirectUri: process.env.KICK_REDIRECT_URI || 'http://localhost:3000/kick/callback',
  kickOauthScopes: parseKickScopes(process.env.KICK_OAUTH_SCOPES || 'user:read events:subscribe'),
  kickPort: parsePortWithPrecedence(),
  kickBroadcasterUserId: process.env.KICK_BROADCASTER_USER_ID || null,
  kickEnabled: Boolean(kickClientId && kickClientSecret),
  subRoleReconciliationEnabled: parseBoolean(process.env.SUB_ROLE_RECONCILIATION_ENABLED, true),
  subRoleReconciliationIntervalMinutes: parsePositiveInteger(
    process.env.SUB_ROLE_RECONCILIATION_INTERVAL_MINUTES || '15',
    15,
  ),
  subRoleReconciliationStartupDelaySeconds: parsePositiveInteger(
    process.env.SUB_ROLE_RECONCILIATION_STARTUP_DELAY_SECONDS || '30',
    30,
  ),
  subRoleReconciliationDiscoveryTimeoutMs: parsePositiveInteger(
    process.env.SUB_ROLE_RECONCILIATION_DISCOVERY_TIMEOUT_MS || '20000',
    20000,
  ),
  subRoleReconciliationUserSyncTimeoutMs: parsePositiveInteger(
    process.env.SUB_ROLE_RECONCILIATION_USER_SYNC_TIMEOUT_MS || '12000',
    12000,
  ),
  shutdownTimeoutMs: parsePositiveIntegerWithMax(
    process.env.SHUTDOWN_TIMEOUT_MS || '10000',
    10000,
    120000,
  ),
  kickHttpMaxBodyBytes: parseBoundedPositiveInteger(process.env.KICK_HTTP_MAX_BODY_BYTES, {
    fallback: 1048576,
    min: 1024,
    max: 10485760,
  }),
  kickHttpBodyTimeoutMs: parseBoundedPositiveInteger(process.env.KICK_HTTP_BODY_TIMEOUT_MS, {
    fallback: 10000,
    min: 1000,
    max: 120000,
  }),
  kickHttpMaxUrlLength: parseBoundedPositiveInteger(process.env.KICK_HTTP_MAX_URL_LENGTH, {
    fallback: 8192,
    min: 256,
    max: 65536,
  }),
  sqliteBackupEnabled: parseBoolean(process.env.SQLITE_BACKUP_ENABLED, true),
  sqliteBackupDirectory: process.env.SQLITE_BACKUP_DIRECTORY || './backups',
  sqliteBackupTime: parseTimeLabelWithFallback(process.env.SQLITE_BACKUP_TIME, '08:15'),
  sqliteBackupTimezone: parseIanaTimeZone(
    process.env.SQLITE_BACKUP_TIMEZONE,
    'America/Sao_Paulo',
  ),
  sqliteBackupRetentionDays: parseBoundedPositiveInteger(process.env.SQLITE_BACKUP_RETENTION_DAYS, {
    fallback: 7,
    min: 1,
    max: 365,
  }),
  sqliteBackupStartupDelaySeconds: parseBoundedPositiveInteger(
    process.env.SQLITE_BACKUP_STARTUP_DELAY_SECONDS,
    {
      fallback: 60,
      min: 0,
      max: 86400,
    },
  ),
  nodeEnv: process.env.NODE_ENV || 'development',
};
