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

  const createQueueCycleStateTableSql = `
    CREATE TABLE IF NOT EXISTS queue_cycle_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_cycle_id INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `;

  const createQueuePrioritySnapshotsTableSql = `
    CREATE TABLE IF NOT EXISTS queue_priority_snapshots (
      cycle_id INTEGER NOT NULL,
      discord_id TEXT NOT NULL,
      is_subscriber INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, discord_id)
    )
  `;

  const createSchedulerStateTableSql = `
    CREATE TABLE IF NOT EXISTS scheduler_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_state TEXT NOT NULL DEFAULT 'closed',
      state_origin TEXT NOT NULL DEFAULT 'scheduled',
      manual_override_state TEXT NULL,
      manual_override_until_ms INTEGER NULL,
      last_scheduled_open_cycle_key TEXT NULL,
      last_scheduled_open_at_ms INTEGER NULL,
      last_scheduled_close_cycle_key TEXT NULL,
      last_scheduled_close_at_ms INTEGER NULL,
      updated_at_ms INTEGER NOT NULL
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

  const createKickFollowEventsTableSql = `
    CREATE TABLE IF NOT EXISTS kick_follow_events (
      event_message_id TEXT PRIMARY KEY,
      broadcaster_user_id TEXT NOT NULL,
      follower_user_id TEXT NOT NULL,
      follower_username TEXT NOT NULL,
      followed_at_ms INTEGER NOT NULL,
      received_at_ms INTEGER NOT NULL
    )
  `;

  const createKickUnlinkAuditTableSql = `
    CREATE TABLE IF NOT EXISTS kick_unlink_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      kick_user_id TEXT NOT NULL,
      kick_username TEXT NOT NULL,
      unlinked_by_discord_id TEXT NOT NULL,
      unlinked_at_ms INTEGER NOT NULL,
      reason TEXT NOT NULL
    )
  `;

  const createSubscriberRoleSyncAuditTableSql = `
    CREATE TABLE IF NOT EXISTS subscriber_role_sync_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      eligible INTEGER NOT NULL,
      kick_active INTEGER NOT NULL,
      manual_active INTEGER NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      triggered_by_discord_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `;

  const createSubscriberRoleReconciliationRunsTableSql = `
    CREATE TABLE IF NOT EXISTS subscriber_role_reconciliation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_type TEXT NOT NULL,
      triggered_by_discord_id TEXT NULL,
      reason TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER NULL,
      total_candidates INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      role_added INTEGER NOT NULL DEFAULT 0,
      role_removed INTEGER NOT NULL DEFAULT 0,
      already_correct INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL
    )
  `;

  const createSqliteBackupRunsTableSql = `
    CREATE TABLE IF NOT EXISTS app_sqlite_backup_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_type TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER NOT NULL,
      file_name TEXT NULL,
      size_bytes INTEGER NULL,
      integrity_result TEXT NOT NULL,
      result TEXT NOT NULL,
      error_code TEXT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `;

  const createSqliteBackupSchedulerStateSql = `
    CREATE TABLE IF NOT EXISTS app_sqlite_backup_scheduler_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_success_local_date TEXT NULL,
      last_attempt_started_at_ms INTEGER NULL,
      last_result TEXT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `;


  db.exec(createUsersTableSql);
  db.exec(createQueueEntriesTableSql);
  db.exec(createLobbiesTableSql);
  db.exec(createLobbyPlayersTableSql);
  db.exec(createQueueCycleStateTableSql);
  db.exec(createQueuePrioritySnapshotsTableSql);
  db.exec(createSchedulerStateTableSql);
  db.exec(createKickAccountsTableSql);
  db.exec(createManualSubGrantsTableSql);
  db.exec(createKickSubscriptionsTableSql);
  db.exec(createKickWebhookEventsTableSql);
  db.exec(createKickFollowEventsTableSql);
  db.exec(createKickUnlinkAuditTableSql);
  db.exec(createSubscriberRoleSyncAuditTableSql);
  db.exec(createSubscriberRoleReconciliationRunsTableSql);
  db.exec(createSqliteBackupRunsTableSql);
  db.exec(createSqliteBackupSchedulerStateSql);

  const cycleState = db.prepare('SELECT id, current_cycle_id FROM queue_cycle_state WHERE id = 1').get();
  if (!cycleState) {
    db.prepare('INSERT INTO queue_cycle_state (id, current_cycle_id, updated_at_ms) VALUES (1, 1, ?)').run(Date.now());
  } else if (!Number.isFinite(cycleState.current_cycle_id) || cycleState.current_cycle_id < 1) {
    db.prepare('UPDATE queue_cycle_state SET current_cycle_id = 1, updated_at_ms = ? WHERE id = 1').run(Date.now());
  }

  const schedulerState = db.prepare('SELECT id FROM scheduler_state WHERE id = 1').get();
  if (!schedulerState) {
    db.prepare(
      `INSERT INTO scheduler_state (
        id,
        current_state,
        state_origin,
        manual_override_state,
        manual_override_until_ms,
        last_scheduled_open_cycle_key,
        last_scheduled_open_at_ms,
        last_scheduled_close_cycle_key,
        last_scheduled_close_at_ms,
        updated_at_ms
      ) VALUES (1, 'closed', 'scheduled', NULL, NULL, NULL, NULL, NULL, NULL, ?)`
    ).run(Date.now());
  }

  const schedulerStateInfo = db.prepare("PRAGMA table_info(scheduler_state)").all();
  const hasLastScheduledCloseCycleKey = schedulerStateInfo.some(
    (column) => column.name === 'last_scheduled_close_cycle_key',
  );
  if (!hasLastScheduledCloseCycleKey) {
    db.exec('ALTER TABLE scheduler_state ADD COLUMN last_scheduled_close_cycle_key TEXT NULL');
  }

  const sqliteBackupSchedulerState = db
    .prepare('SELECT id FROM app_sqlite_backup_scheduler_state WHERE id = 1')
    .get();
  if (!sqliteBackupSchedulerState) {
    db.prepare(
      `INSERT INTO app_sqlite_backup_scheduler_state (
        id,
        last_success_local_date,
        last_attempt_started_at_ms,
        last_result,
        updated_at_ms
      ) VALUES (1, NULL, NULL, NULL, ?)`
    ).run(Date.now());
  }

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

  const reconciliationRunsByStartedAt = db
    .prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_sub_role_reconciliation_runs_started_at_ms'")
    .get();
  if (reconciliationRunsByStartedAt && reconciliationRunsByStartedAt.c === 0) {
    db.exec(
      'CREATE INDEX idx_sub_role_reconciliation_runs_started_at_ms ON subscriber_role_reconciliation_runs(started_at_ms)',
    );
  }

  const reconciliationRunsByStatus = db
    .prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_sub_role_reconciliation_runs_status'")
    .get();
  if (reconciliationRunsByStatus && reconciliationRunsByStatus.c === 0) {
    db.exec(
      'CREATE INDEX idx_sub_role_reconciliation_runs_status ON subscriber_role_reconciliation_runs(status)',
    );
  }

  const queueSnapshotsByDiscord = db
    .prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_queue_priority_snapshots_discord_id'")
    .get();
  if (queueSnapshotsByDiscord && queueSnapshotsByDiscord.c === 0) {
    db.exec('CREATE INDEX idx_queue_priority_snapshots_discord_id ON queue_priority_snapshots(discord_id)');
  }

  const backupRunsByCreatedAt = db
    .prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_app_sqlite_backup_runs_created_at_ms'")
    .get();
  if (backupRunsByCreatedAt && backupRunsByCreatedAt.c === 0) {
    db.exec('CREATE INDEX idx_app_sqlite_backup_runs_created_at_ms ON app_sqlite_backup_runs(created_at_ms DESC)');
  }

  const backupRunsByResult = db
    .prepare("SELECT COUNT(1) AS c FROM sqlite_master WHERE type='index' AND name='idx_app_sqlite_backup_runs_result'")
    .get();
  if (backupRunsByResult && backupRunsByResult.c === 0) {
    db.exec('CREATE INDEX idx_app_sqlite_backup_runs_result ON app_sqlite_backup_runs(result)');
  }

}

module.exports = {
  initDatabase,
};
