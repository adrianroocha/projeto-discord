const { createKickWebhookPublicKeyService } = require('../src/services/kickWebhookPublicKeyService');

describe('kickWebhookPublicKeyService', () => {
  test('busca chave pública e utiliza cache', async () => {
    let nowMs = 1000;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { public_key: 'PUBLIC-KEY-PEM' } }),
    });

    const service = createKickWebhookPublicKeyService({
      fetchImpl: fetchMock,
      now: () => nowMs,
      ttlMs: 10_000,
      url: 'https://api.kick.com/public/v1/public-key',
    });

    const first = await service.getPublicKey();
    const second = await service.getPublicKey();

    expect(first).toBe('PUBLIC-KEY-PEM');
    expect(second).toBe('PUBLIC-KEY-PEM');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowMs = 12_000;
    await service.getPublicKey();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
