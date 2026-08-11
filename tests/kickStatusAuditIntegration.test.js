const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { createTestContext } = require('./helpers/testDatabase');

function makeEligibility() {
  return {
    eligible: true,
    sources: {
      kick: {
        linked: true,
        active: true,
        observed: true,
        kickUserId: '75942843',
        kickUsername: 'sensitive-kick-user',
        startedAtMs: 1_000,
        expiresAtMs: 2_000,
        subscriptionType: 'direct',
      },
      manual: {
        active: true,
        reason: 'Sensitive manual reason',
        grantedByDiscordId: 'admin-2',
        grantedAtMs: 3_000,
        expiresAtMs: 4_000,
      },
    },
  };
}

describe('/kick-status administrative audit integration', () => {
  let context;
  let command;
  let auditRepository;
  let kickAccountsRepository;
  let subscriberEligibilityService;

  function loadCommandWithEligibility(factory) {
    jest.doMock('../src/services/subscriberEligibilityService', () => ({
      getEligibility: jest.fn(factory),
    }));

    command = require('../src/commands/kickStatus');
    auditRepository = require('../src/database/adminCommandAuditLogsRepository');
    kickAccountsRepository = require('../src/database/kickAccountsRepository');
    subscriberEligibilityService = require('../src/services/subscriberEligibilityService');

    jest.spyOn(kickAccountsRepository, 'findByDiscordId').mockReturnValue({ linked_at_ms: 5000 });
    jest.spyOn(kickAccountsRepository, 'upsert');
    jest.spyOn(kickAccountsRepository, 'deleteByDiscordId');
    jest.spyOn(kickAccountsRepository, 'unlinkWithAudit');
  }

  function createInteraction(options = {}) {
    const actorId = options.actorId || 'admin-1';
    const targetId = options.targetId || 'target-1';
    const actorPermissionFlags = options.actorPermissionFlags || [];
    const actorRoleIds = options.actorRoleIds || [];

    return {
      id: options.interactionId || 'kick-status-third-party',
      commandName: 'kick-status',
      guildId: 'test-guild',
      channelId: 'channel-1',
      client: { channels: { fetch: jest.fn() } },
      inGuild: () => true,
      guild: {
        members: {
          fetch: jest.fn(async (discordId) => {
            if (discordId === actorId) {
              return {
                manageable: true,
                permissions: {
                  has: (flag) => actorPermissionFlags.includes(flag),
                },
                roles: { cache: { has: (roleId) => actorRoleIds.includes(roleId) } },
              };
            }

            if (options.targetUnavailable) {
              throw new Error('not found');
            }

            if (discordId === targetId) {
              return {
                manageable: true,
                permissions: { has: () => false },
                roles: { cache: { has: () => false } },
              };
            }

            throw new Error('not found');
          }),
        },
      },
      user: { id: actorId, username: actorId },
      options: {
        getUser: jest.fn().mockReturnValue({ id: targetId }),
      },
      reply: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(async () => {
    context = await createTestContext({
      nodeEnv: 'test',
      subscriberRoleId: 'sub-role-1',
      botOperatorRoleIds: '900000000000000001',
    });
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('consulta administrativa de terceiro é auditada sem dados sensíveis da Kick', async () => {
    loadCommandWithEligibility(() => makeEligibility());
    const interaction = createInteraction({ actorPermissionFlags: [PermissionFlagsBits.Administrator] });

    await command.execute(interaction);

    const latest = auditRepository.findLatest();
    expect(latest.commandName).toBe('kick-status');
    expect(latest.result).toBe('success');
    expect(latest.parametersJson).toContain('targetDiscordId');
    expect(latest.parametersJson).not.toContain('sensitive-kick-user');
    expect(latest.parametersJson).not.toContain('75942843');
    expect(latest.nextStateJson).toContain('targetDiscordId');
    expect(latest.nextStateJson).not.toContain('Sensitive manual reason');
    expect(latest.nextStateJson).not.toContain('kickUsername');
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(subscriberEligibilityService.getEligibility).toHaveBeenCalledWith('target-1');
    expect(kickAccountsRepository.upsert).not.toHaveBeenCalled();
    expect(kickAccountsRepository.deleteByDiscordId).not.toHaveBeenCalled();
    expect(kickAccountsRepository.unlinkWithAudit).not.toHaveBeenCalled();
  });

  test('consulta administrativa negada persiste denied com metadados mínimos', async () => {
    loadCommandWithEligibility(() => makeEligibility());
    const interaction = createInteraction({
      actorId: 'user-1',
      targetId: 'target-denied',
      actorPermissionFlags: [],
      interactionId: 'kick-status-third-party-denied',
    });

    await command.execute(interaction);

    const latest = auditRepository.findLatest();
    expect(latest.commandName).toBe('kick-status');
    expect(latest.result).toBe('denied');
    expect(latest.errorCode).toBe('MISSING_PERMISSION');
    expect(latest.actorDiscordId).toBe('user-1');
    expect(latest.parametersJson).toContain('targetDiscordId');
    expect(latest.parametersJson).toContain('target-denied');
    expect(latest.parametersJson).not.toContain('kickUsername');
    expect(latest.parametersJson).not.toContain('kickUserId');
    expect(latest.parametersJson).not.toContain('token');
    expect(latest.parametersJson).not.toContain('payload');
    expect(latest.nextStateJson).toContain('targetDiscordId');
    expect(latest.nextStateJson).not.toContain('Sensitive manual reason');
    expect(latest.nextStateJson).not.toContain('75942843');
    expect(subscriberEligibilityService.getEligibility).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  test('consulta administrativa autorizada que falha persiste failed com código seguro', async () => {
    loadCommandWithEligibility(() => {
      throw new Error('kick read failed token=abc stack=trace secret=xyz');
    });
    const interaction = createInteraction({
      actorId: 'admin-failed',
      targetId: 'target-failed',
      actorPermissionFlags: [PermissionFlagsBits.ManageGuild],
      interactionId: 'kick-status-third-party-failed',
    });

    await command.execute(interaction);

    const latest = auditRepository.findLatest();
    expect(latest.commandName).toBe('kick-status');
    expect(latest.result).toBe('failed');
    expect(latest.errorCode).toBe('KICK_STATUS_READ_FAILED');
    expect(latest.actorDiscordId).toBe('admin-failed');
    expect(latest.parametersJson).toContain('target-failed');
    expect(latest.parametersJson).not.toContain('kickUsername');
    expect(latest.nextStateJson).toContain('target-failed');
    expect(latest.nextStateJson).not.toContain('token=abc');
    expect(latest.nextStateJson).not.toContain('stack');
    expect(latest.nextStateJson).not.toContain('secret');
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não foi possível consultar o status no momento. Código: KICK_STATUS_READ_FAILED.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });
});