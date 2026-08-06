const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = process.cwd();
const databaseModulePath = path.join(projectRoot, 'src/database/database.js');
const sqliteClientModulePath = path.join(projectRoot, 'src/database/sqliteClient.js');
const queueServiceModulePath = path.join(projectRoot, 'src/services/queueService.js');

function createTempDatabasePath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projeto-discord-tests-'));
  return {
    tempDir,
    databasePath: path.join(tempDir, 'database.sqlite'),
  };
}

async function createTestContext(options = {}) {
  const { tempDir, databasePath } = options.databasePath
    ? { tempDir: path.dirname(options.databasePath), databasePath: options.databasePath }
    : createTempDatabasePath();

  jest.resetModules();

  process.env.NODE_ENV = options.nodeEnv || 'test';
  process.env.DATABASE_PATH = databasePath;
  process.env.DISCORD_TOKEN = 'test-token';
  process.env.GUILD_ID = 'test-guild';
  process.env.CLIENT_ID = options.clientId || '';
  process.env.SUBSCRIBER_ROLE_ID = options.subscriberRoleId || '';
  process.env.QUEUE_CHANNEL_ID = options.queueChannelId || '';
  process.env.QUEUE_PANEL_CHANNEL_ID = options.queuePanelChannelId || '';
  process.env.QUEUE_OPEN_TIME = options.queueOpenTime || '18:58';
  process.env.QUEUE_CLOSE_TIME = options.queueCloseTime || '06:00';
  process.env.QUEUE_TIMEZONE = options.queueTimezone || 'America/Sao_Paulo';
  process.env.QUEUE_TEST_INTERVAL_MINUTES = String(options.queueTestIntervalMinutes || 5);
  process.env.KICK_BROADCASTER_USER_ID = options.kickBroadcasterUserId || '';

  const database = require(databaseModulePath);
  const sqliteClient = require(sqliteClientModulePath);

  await database.initDatabase();
  const queueService = require(queueServiceModulePath);
  const queueEvents = require(path.join(projectRoot, 'src/services/queueEvents.js'));

  async function cleanup() {
    await sqliteClient.closeConnection();

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    delete process.env.NODE_ENV;
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_TOKEN;
    delete process.env.GUILD_ID;
    delete process.env.QUEUE_PANEL_CHANNEL_ID;
    delete process.env.CLIENT_ID;
    delete process.env.SUBSCRIBER_ROLE_ID;
    delete process.env.QUEUE_CHANNEL_ID;
    delete process.env.QUEUE_OPEN_TIME;
    delete process.env.QUEUE_CLOSE_TIME;
    delete process.env.QUEUE_TIMEZONE;
    delete process.env.QUEUE_TEST_INTERVAL_MINUTES;
    delete process.env.KICK_BROADCASTER_USER_ID;

    jest.resetModules();
    jest.restoreAllMocks();
  }

  return {
    tempDir,
    databasePath,
    database,
    sqliteClient,
    queueService,
    queueEvents,
    cleanup,
  };
}

function getDb(sqliteClient) {
  return sqliteClient.getDatabase();
}

function countRows(db, tableName) {
  return db.prepare(`SELECT COUNT(1) AS count FROM ${tableName}`).get().count;
}

function insertLobby(db, lobby) {
  db.prepare(
    `INSERT INTO lobbies (id, created_at_ms, status, creation_type, lobby_number) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    lobby.id,
    lobby.createdAtMs,
    lobby.status,
    lobby.creationType,
    lobby.lobbyNumber,
  );
}

function insertLobbyPlayer(db, player) {
  db.prepare(
    `INSERT INTO lobby_players (id, lobby_id, discord_id, username, display_name, position, original_joined_at_ms, is_subscriber) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    player.id,
    player.lobbyId,
    player.discordId,
    player.username,
    player.displayName,
    player.position,
    player.originalJoinedAtMs,
    player.isSubscriber ? 1 : 0,
  );
}

function seedQueueEntry(db, entry) {
  db.prepare(
    `INSERT INTO queue_entries (id, discord_id, username, display_name, is_subscriber, joined_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.discordId,
    entry.username,
    entry.displayName,
    entry.isSubscriber ? 1 : 0,
    entry.joinedAtMs,
  );
}

module.exports = {
  createTestContext,
  getDb,
  countRows,
  insertLobby,
  insertLobbyPlayer,
  seedQueueEntry,
};
