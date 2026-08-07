const { createTestContext } = require('./helpers/testDatabase');

let context;
let repository;

describe('subscriberRoleSyncAuditRepository', () => {
  beforeEach(async () => {
    context = await createTestContext();
    repository = require('../src/database/subscriberRoleSyncAuditRepository');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('registra auditoria e consulta latest', () => {
    repository.register({
      discordId: 'user-1',
      eligible: true,
      kickActive: false,
      manualActive: true,
      action: 'role_added',
      result: 'role_added',
      triggeredByDiscordId: 'admin-1',
      triggerType: 'command_sub_sync',
      reason: 'teste',
      createdAtMs: Date.now(),
    });

    expect(repository.countAll()).toBe(1);

    const latest = repository.findLatest();
    expect(latest.discord_id).toBe('user-1');
    expect(latest.action).toBe('role_added');
  });
});
