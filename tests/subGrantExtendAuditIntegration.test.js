const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { createTestContext, getDb } = require('./helpers/testDatabase');

function makeActorMember(flags = []) {
  return {
    permissions: {
      has: (flag) => flags.includes(flag),
    },
    roles: {
      cache: {
        has: () => false,
      },
    },
  };
}

function makeInteraction({
  id = 'int-sub-extend-1',
  actorId = 'admin-1',
  actorFlags = [PermissionFlagsBits.Administrator],
  targetUserId = 'target-1',
  days = 20,
  reason = 'Renovacao via PIX',
  client,
}) {
  return {
    id,
    commandName: 'sub-grant-extend',
    guildId: 'test-guild',
    channelId: 'channel-1',
    inGuild: () => true,
    user: {
      id: actorId,
      username: 'adminUser',
    },
    guild: {
      members: {
        fetch: jest.fn(async (discordId) => {
          if (discordId === actorId) {
            return makeActorMember(actorFlags);
          }

          return {
            id: discordId,
            permissions: { has: () => false },
          };
        }),
      },
    },
    options: {
      getUser: jest.fn((name) => (name === 'usuario' ? { id: targetUserId, bot: false } : null)),
      getInteger: jest.fn((name) => (name === 'dias' ? days : null)),
      getString: jest.fn((name) => (name === 'motivo' ? reason : null)),
    },
    client,
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('/sub-grant-extend audit integration', () => {
  let context;
  let db;
  let command;
  let auditRepository;
  let autoSyncService;
  let dateNowSpy;

  const NOW_MS = 1_726_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    context = await createTestContext({
      nodeEnv: 'test',
      guildId: 'test-guild',
      subscriberRoleId: 'sub-role-1',
    });
    db = getDb(context.sqliteClient);

    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);

    command = require('../src/commands/subGrantExtend');
    auditRepository = require('../src/database/adminCommandAuditLogsRepository');
    autoSyncService = require('../src/services/subscriberRoleAutoSyncService');
  });

  afterEach(async () => {
    if (dateNowSpy) {
      dateNowSpy.mockRestore();
    }
    await context.cleanup();
  });

  function seedGrant({ discordId = 'target-1', expiresAtMs = NOW_MS + 10 * DAY_MS } = {}) {
    db.prepare(
      `INSERT INTO manual_sub_grants (
        discord_id,
        granted_by_discord_id,
        reason,
        granted_at_ms,
        expires_at_ms,
        revoked_at_ms,
        revoked_by_discord_id,
        revoke_reason
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(discordId, 'admin-original', 'Grant inicial', NOW_MS - 20 * DAY_MS, expiresAtMs);
  }

  test('success: estende, audita success e chama sync uma vez', async () => {
    seedGrant({ discordId: 'target-success', expiresAtMs: NOW_MS + 10 * DAY_MS });
    const syncSpy = jest.spyOn(autoSyncService, 'syncAfterEligibilityChange');

    const interaction = makeInteraction({
      id: 'interaction-success',
      targetUserId: 'target-success',
      client: {},
    });

    await command.execute(interaction);

    const row = db.prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ?').get('target-success');
    expect(row.expires_at_ms).toBe(NOW_MS + 30 * DAY_MS);

    const latest = auditRepository.findLatest();
    expect(latest.commandName).toBe('sub-grant-extend');
    expect(latest.result).toBe('success');
    expect(latest.errorCode).toBe('OK');
    expect(latest.parametersJson).toContain('"usuario":"target-success"');
    expect(latest.parametersJson).toContain('"dias":20');
    expect(latest.parametersJson).not.toMatch(/token|payload|stack|secret|exception/i);
    expect(latest.nextStateJson).toContain('"previousExpiresAtMs"');
    expect(latest.nextStateJson).toContain('"newExpiresAtMs"');

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('denied: sem Administrator não muta e audita denied', async () => {
    seedGrant({ discordId: 'target-denied', expiresAtMs: NOW_MS + 10 * DAY_MS });

    const interaction = makeInteraction({
      id: 'interaction-denied',
      actorFlags: [],
      targetUserId: 'target-denied',
      client: {},
    });

    await command.execute(interaction);

    const row = db.prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ?').get('target-denied');
    expect(row.expires_at_ms).toBe(NOW_MS + 10 * DAY_MS);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('denied');
    expect(latest.errorCode).toBe('MISSING_PERMISSION');
  });

  test('denied: apenas ManageGuild não autoriza extensão', async () => {
    seedGrant({ discordId: 'target-manage-guild', expiresAtMs: NOW_MS + 10 * DAY_MS });

    const interaction = makeInteraction({
      id: 'interaction-manage-guild-denied',
      actorFlags: [PermissionFlagsBits.ManageGuild],
      targetUserId: 'target-manage-guild',
      client: {},
    });

    await command.execute(interaction);

    const row = db
      .prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ?')
      .get('target-manage-guild');
    expect(row.expires_at_ms).toBe(NOW_MS + 10 * DAY_MS);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('denied');
    expect(latest.errorCode).toBe('MISSING_PERMISSION');
  });

  test('denied: apenas cargo de operador não autoriza extensão', async () => {
    seedGrant({ discordId: 'target-operator-role', expiresAtMs: NOW_MS + 10 * DAY_MS });

    const interaction = makeInteraction({
      id: 'interaction-operator-role-denied',
      actorFlags: [],
      targetUserId: 'target-operator-role',
      client: {},
    });

    interaction.guild.members.fetch = jest.fn(async (discordId) => {
      if (discordId === interaction.user.id) {
        return {
          permissions: {
            has: () => false,
          },
          roles: {
            cache: {
              has: (roleId) => roleId === '900000000000000001',
            },
          },
        };
      }

      return {
        id: discordId,
        permissions: { has: () => false },
      };
    });

    await command.execute(interaction);

    const row = db
      .prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ?')
      .get('target-operator-role');
    expect(row.expires_at_ms).toBe(NOW_MS + 10 * DAY_MS);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('denied');
    expect(latest.errorCode).toBe('MISSING_PERMISSION');
  });

  test('failed: concessão revogada não é reativada e audita failed', async () => {
    seedGrant({ discordId: 'target-revoked', expiresAtMs: NOW_MS + 8 * DAY_MS });
    db.prepare(
      `UPDATE manual_sub_grants
       SET revoked_at_ms = ?, revoked_by_discord_id = ?, revoke_reason = ?
       WHERE discord_id = ?`,
    ).run(NOW_MS - DAY_MS, 'admin-revoker', 'Encerrado', 'target-revoked');

    const syncSpy = jest.spyOn(autoSyncService, 'syncAfterEligibilityChange');

    const interaction = makeInteraction({
      id: 'interaction-failed-revoked',
      targetUserId: 'target-revoked',
      client: {},
    });

    await command.execute(interaction);

    const latest = auditRepository.findLatest();
    expect(latest.result).toBe('failed');
    expect(latest.errorCode).toBe('MANUAL_GRANT_REVOKED');
    expect(syncSpy).not.toHaveBeenCalled();
  });

  test('falha de beginRequired bloqueia mutação', async () => {
    seedGrant({ discordId: 'target-audit-fail', expiresAtMs: NOW_MS + 10 * DAY_MS });

    const adminAuditService = require('../src/services/adminCommandAuditService');
    const beginSpy = jest
      .spyOn(adminAuditService, 'beginRequired')
      .mockRejectedValueOnce(new Error('sqlite unavailable'));

    const interaction = makeInteraction({
      id: 'interaction-audit-fail',
      targetUserId: 'target-audit-fail',
      client: {},
    });

    await command.execute(interaction);
    beginSpy.mockRestore();

    const row = db.prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ?').get('target-audit-fail');
    expect(row.expires_at_ms).toBe(NOW_MS + 10 * DAY_MS);
    expect(auditRepository.countAll()).toBe(0);
  });

  test('idempotência: mesma interaction_id não acumula extensão', async () => {
    seedGrant({ discordId: 'target-idempotent', expiresAtMs: NOW_MS + 10 * DAY_MS });
    const syncSpy = jest.spyOn(autoSyncService, 'syncAfterEligibilityChange');

    const interaction = makeInteraction({
      id: 'interaction-idempotent',
      targetUserId: 'target-idempotent',
      client: {},
    });

    await command.execute(interaction);
    const afterFirst = db.prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ?').get('target-idempotent').expires_at_ms;

    await command.execute(interaction);
    const afterSecond = db.prepare('SELECT expires_at_ms FROM manual_sub_grants WHERE discord_id = ?').get('target-idempotent').expires_at_ms;

    expect(afterFirst).toBe(NOW_MS + 30 * DAY_MS);
    expect(afterSecond).toBe(afterFirst);
    expect(auditRepository.countAll()).toBe(1);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: 'Esta interação já foi processada anteriormente.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });
});
