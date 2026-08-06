const { openConnection, getDatabase } = require('./sqliteClient');

async function initDatabase() {
  await openConnection();

  const db = getDatabase();
  const createUsersTableSql = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `;

  const createQueueEntriesTableSql = `
    CREATE TABLE IF NOT EXISTS queue_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      is_subscriber INTEGER DEFAULT 0,
      joined_at_ms INTEGER NOT NULL,
      status TEXT DEFAULT 'waiting'
    )
  `;

  const createLobbiesTableSql = `
    CREATE TABLE IF NOT EXISTS lobbies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      status TEXT DEFAULT 'forming',
      creation_type TEXT NOT NULL DEFAULT 'automatic',
      lobby_number INTEGER NOT NULL
    )
  `;

  const createLobbyPlayersTableSql = `
    CREATE TABLE IF NOT EXISTS lobby_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lobby_id INTEGER NOT NULL,
      discord_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      position INTEGER NOT NULL,
      original_joined_at_ms INTEGER NOT NULL,
      is_subscriber INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (lobby_id) REFERENCES lobbies(id)
    )
  `;

  const createKickAccountsTableSql = `
    CREATE TABLE IF NOT EXISTS kick_accounts (
      discord_id TEXT PRIMARY KEY,
      kick_user_id TEXT NOT NULL UNIQUE,
      kick_username TEXT NOT NULL,
      linked_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `;

  const createManualSubGrantsTableSql = `
    CREATE TABLE IF NOT EXISTS manual_sub_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      granted_by_discord_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      granted_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NULL,
      revoked_at_ms INTEGER NULL,
      revoked_by_discord_id TEXT NULL,
      revoke_reason TEXT NULL
    )
  `;

  const createKickSubscriptionsTableSql = `
    CREATE TABLE IF NOT EXISTS kick_subscriptions (
      broadcaster_user_id TEXT NOT NULL,
      kick_user_id TEXT NOT NULL,
      kick_username TEXT NOT NULL,
      subscription_type TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      last_event_message_id TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_user_id, kick_user_id)
    )
  `;

  const createKickWebhookEventsTableSql = `
    CREATE TABLE IF NOT EXISTS kick_webhook_events (
      event_message_id TEXT PRIMARY KEY,
      event_subscription_id TEXT,
      event_type TEXT NOT NULL,
      event_version TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL,
      processed_at_ms INTEGER NOT NULL
    )
  `;

  db.exec(createUsersTableSql);
  db.exec(createQueueEntriesTableSql);
  db.exec(createLobbiesTableSql);
  db.exec(createLobbyPlayersTableSql);
  db.exec(createKickAccountsTableSql);
  db.exec(createManualSubGrantsTableSql);
  db.exec(createKickSubscriptionsTableSql);
  db.exec(createKickWebhookEventsTableSql);

  const lobbyInfo = db.prepare("PRAGMA table_info(lobbies)").all();
  const hasLobbyStatus = lobbyInfo.some((column) => column.name === 'status');
  if (!hasLobbyStatus) {
    db.exec("ALTER TABLE lobbies ADD COLUMN status TEXT NOT NULL DEFAULT 'forming'");
  }

  db.exec("UPDATE lobbies SET status = 'forming' WHERE status = 'open'");

  // Add creation_type column to lobbies to differentiate automatic vs forced lobbies (idempotent)
  const hasCreationType = lobbyInfo.some((column) => column.name === 'creation_type');
  if (!hasCreationType) {
    db.exec("ALTER TABLE lobbies ADD COLUMN creation_type TEXT NOT NULL DEFAULT 'automatic'");
  }

  const hasLobbyNumber = db.prepare("PRAGMA table_info(lobbies)").all().some((column) => column.name === 'lobby_number');
  if (!hasLobbyNumber) {
    db.exec("ALTER TABLE lobbies ADD COLUMN lobby_number INTEGER NOT NULL DEFAULT 0");
  }

  const lobbyPlayersInfo = db.prepare("PRAGMA table_info(lobby_players)").all();
  const hasOriginalJoinedAtMs = lobbyPlayersInfo.some((column) => column.name === 'original_joined_at_ms');
  if (!hasOriginalJoinedAtMs) {
    db.exec("ALTER TABLE lobby_players ADD COLUMN original_joined_at_ms INTEGER NOT NULL DEFAULT 0");
  }

  const hasLobbyPlayerSubscriber = lobbyPlayersInfo.some((column) => column.name === 'is_subscriber');
  if (!hasLobbyPlayerSubscriber) {
    db.exec("ALTER TABLE lobby_players ADD COLUMN is_subscriber INTEGER NOT NULL DEFAULT 0");
  }

  const queueInfo = db.prepare("PRAGMA table_info(queue_entries)").all();
  const hasDisplayName = queueInfo.some((column) => column.name === 'display_name');
  if (!hasDisplayName) {
    db.exec("ALTER TABLE queue_entries ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }

  const hasJoinedAtMs = queueInfo.some((column) => column.name === 'joined_at_ms');
  if (!hasJoinedAtMs) {
    db.exec("ALTER TABLE queue_entries ADD COLUMN joined_at_ms INTEGER NOT NULL DEFAULT 0");
  }

  const lobbiesInfo = db.prepare("PRAGMA table_info(lobbies)").all();
  const hasCreatedAtMs = lobbiesInfo.some((column) => column.name === 'created_at_ms');
  if (!hasCreatedAtMs) {
    db.exec("ALTER TABLE lobbies ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0");
  }

  // Ensure queue_entries does not contain players that are already in lobbies
  // (safe to run multiple times)
  try {
    const count = db.prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='table' AND name='lobby_players'").get();
    if (count && count.c > 0) {
      db.exec(
        "DELETE FROM queue_entries WHERE discord_id IN (SELECT DISTINCT discord_id FROM lobby_players)"
      );
    }
  } catch (err) {
    // ignore if something unexpected happens during cleanup
    console.error('Cleanup migration warning:', err && err.message);
  }

  const indexInfo = db.prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_lobbies_lobby_number'").get();
  if (indexInfo && indexInfo.c === 0) {
    try {
      db.exec('CREATE UNIQUE INDEX idx_lobbies_lobby_number ON lobbies(lobby_number)');
    } catch (err) {
      console.error('Erro ao criar índice de lobby_number:', err && err.message);
    }
  }

  const manualSubIndexByDiscord = db
    .prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_manual_sub_grants_discord_id'")
    .get();
  if (manualSubIndexByDiscord && manualSubIndexByDiscord.c === 0) {
    db.exec('CREATE INDEX idx_manual_sub_grants_discord_id ON manual_sub_grants(discord_id)');
  }

  const manualSubIndexByActive = db
    .prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_manual_sub_grants_active_lookup'")
    .get();
  if (manualSubIndexByActive && manualSubIndexByActive.c === 0) {
    db.exec(
      'CREATE INDEX idx_manual_sub_grants_active_lookup ON manual_sub_grants(discord_id, revoked_at_ms, expires_at_ms, granted_at_ms)',
    );
  }

  const kickSubByKickUser = db
    .prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_kick_subscriptions_kick_user_id'")
    .get();
  if (kickSubByKickUser && kickSubByKickUser.c === 0) {
    db.exec('CREATE INDEX idx_kick_subscriptions_kick_user_id ON kick_subscriptions(kick_user_id)');
  }

  const kickSubByExpires = db
    .prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_kick_subscriptions_expires_at_ms'")
    .get();
  if (kickSubByExpires && kickSubByExpires.c === 0) {
    db.exec('CREATE INDEX idx_kick_subscriptions_expires_at_ms ON kick_subscriptions(expires_at_ms)');
  }

  const kickSubByBroadcaster = db
    .prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_kick_subscriptions_broadcaster_user_id'")
    .get();
  if (kickSubByBroadcaster && kickSubByBroadcaster.c === 0) {
    db.exec(
      'CREATE INDEX idx_kick_subscriptions_broadcaster_user_id ON kick_subscriptions(broadcaster_user_id)',
    );
  }
}

module.exports = {
  initDatabase,
};
