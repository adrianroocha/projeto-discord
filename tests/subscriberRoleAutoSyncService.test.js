process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'test-guild';

const { createSubscriberRoleAutoSyncService } = require('../src/services/subscriberRoleAutoSyncService');

describe('subscriberRoleAutoSyncService', () => {
  function createService(overrides = {}) {
    const subscriberRoleSyncService =
      overrides.subscriberRoleSyncService || {
        syncUser: jest.fn().mockResolvedValue({
          eligibility: true,
          sources: { kick: false, manual: true },
          action: 'role_added',
          result: 'role_added',
        }),
      };

    const logger =
      overrides.logger || {
        info: jest.fn(),
        warn: jest.fn(),
      };

    const service = createSubscriberRoleAutoSyncService({
      subscriberRoleSyncService,
      logger,
    });

    return {
      service,
      subscriberRoleSyncService,
      logger,
    };
  }

  test('sincroniza e normaliza role added', async () => {
    const { service, subscriberRoleSyncService } = createService();

    const result = await service.syncAfterEligibilityChange({
      discordId: 'user-1',
      triggerType: 'manual_grant',
      reason: 'Teste',
      triggeredByDiscordId: 'admin-1',
      client: {},
    });

    expect(subscriberRoleSyncService.syncUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        triggerType: 'manual_grant',
        reason: 'Teste',
        triggeredByDiscordId: 'admin-1',
      }),
    );
    expect(result.status).toBe('synced');
    expect(result.roleState).toBe('added');
    expect(result.ok).toBe(true);
  });

  test('normaliza already_present como mantido', async () => {
    const { service } = createService({
      subscriberRoleSyncService: {
        syncUser: jest.fn().mockResolvedValue({
          eligibility: true,
          sources: { kick: true, manual: false },
          action: 'already_correct',
          result: 'already_present',
        }),
      },
    });

    const result = await service.syncAfterEligibilityChange({
      discordId: 'user-2',
      triggerType: 'kick_link',
      reason: 'Link',
    });

    expect(result.status).toBe('synced');
    expect(result.roleState).toBe('kept');
    expect(result.sources).toEqual({ kick: true, manual: false });
  });

  test('retorna warning em elegibilidade indisponível sem lançar', async () => {
    const { service } = createService({
      subscriberRoleSyncService: {
        syncUser: jest.fn().mockResolvedValue({
          eligibility: null,
          sources: { kick: false, manual: false },
          action: 'not_altered',
          result: 'eligibility_error',
        }),
      },
    });

    const result = await service.syncAfterEligibilityChange({
      discordId: 'user-3',
      triggerType: 'manual_revoke',
      reason: 'Revoke',
    });

    expect(result.status).toBe('warning');
    expect(result.roleState).toBe('pending');
    expect(result.resultCode).toBe('eligibility_error');
  });

  test('discordId inválido retorna warning controlado', async () => {
    const { service, subscriberRoleSyncService } = createService();

    const result = await service.syncAfterEligibilityChange({
      discordId: '   ',
      triggerType: 'manual_grant',
      reason: 'X',
    });

    expect(result.status).toBe('warning');
    expect(result.resultCode).toBe('invalid_discord_id');
    expect(subscriberRoleSyncService.syncUser).not.toHaveBeenCalled();
  });

  test('erro inesperado vira warning sync_unavailable', async () => {
    const { service } = createService({
      subscriberRoleSyncService: {
        syncUser: jest.fn().mockRejectedValue(new Error('boom')),
      },
    });

    const result = await service.syncAfterEligibilityChange({
      discordId: 'user-9',
      triggerType: 'kick_subscription_new',
      reason: 'Webhook',
    });

    expect(result.status).toBe('warning');
    expect(result.warning).toBe('sync_unavailable');
    expect(result.resultCode).toBe('unexpected_error');
  });
});
