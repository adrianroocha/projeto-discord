const { createTestContext } = require('./helpers/testDatabase');

describe('cooldown', () => {
  let context;

  beforeEach(async () => {
    context = await createTestContext({ nodeEnv: 'development' });
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('retorna 120, 60 e libera após 120 segundos sem valores negativos', () => {
    const baseTime = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    const result = context.queueService.addToQueue({
      discordId: 'cooldown-user-1',
      username: 'Cooldown User#0001',
      displayName: 'Cooldown User',
      isSubscriber: 0,
    });

    expect(result.success).toBe(true);

    nowSpy.mockReturnValue(baseTime + 60_000);
    expect(context.queueService.getLeaveCooldown('cooldown-user-1')).toEqual({
      canLeave: false,
      remainingSeconds: 60,
    });

    nowSpy.mockReturnValue(baseTime + 120_000);
    expect(context.queueService.getLeaveCooldown('cooldown-user-1')).toEqual({
      canLeave: true,
      remainingSeconds: 0,
    });

    nowSpy.mockReturnValue(baseTime + 600_000);
    expect(context.queueService.getLeaveCooldown('cooldown-user-1')).toEqual({
      canLeave: true,
      remainingSeconds: 0,
    });
  });

  test('test-user ignora cooldown somente em desenvolvimento', () => {
    context.queueService.addToQueue({
      discordId: 'test-user-001',
      username: 'Jogador Teste 01',
      displayName: 'Jogador Teste 01',
      isSubscriber: 0,
    });

    expect(context.queueService.getLeaveCooldown('test-user-001')).toEqual({
      canLeave: true,
      remainingSeconds: 0,
    });
  });

  test('usuário real não ignora cooldown', () => {
    const baseTime = 2_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    context.queueService.addToQueue({
      discordId: 'real-user-2',
      username: 'Real User#0002',
      displayName: 'Real User',
      isSubscriber: 0,
    });

    expect(context.queueService.getLeaveCooldown('real-user-2')).toEqual({
      canLeave: false,
      remainingSeconds: 120,
    });
  });
});
