const crypto = require('crypto');
const { createKickWebhookSignatureService } = require('../src/services/kickWebhookSignatureService');

function signPayload(privateKey, headers, rawBody) {
  const message = Buffer.concat([
    Buffer.from(`${headers['Kick-Event-Message-Id']}.${headers['Kick-Event-Message-Timestamp']}.`, 'utf8'),
    rawBody,
  ]);
  return crypto
    .sign('RSA-SHA256', message, {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    })
    .toString('base64');
}

describe('kickWebhookSignatureService', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  function buildHeaders(rawBody) {
    const headers = {
      'Kick-Event-Message-Id': 'evt-1',
      'Kick-Event-Subscription-Id': 'sub-1',
      'Kick-Event-Message-Timestamp': '2026-08-06T00:00:00.000Z',
      'Kick-Event-Type': 'channel.subscription.new',
      'Kick-Event-Version': '1',
    };

    headers['Kick-Event-Signature'] = signPayload(privateKey, headers, rawBody);
    return headers;
  }

  test('aceita assinatura válida', async () => {
    const rawBody = Buffer.from('{"ok":true}', 'utf8');
    const headers = buildHeaders(rawBody);

    const service = createKickWebhookSignatureService({
      publicKeyProvider: async () => publicKey.export({ type: 'spki', format: 'pem' }),
    });

    const result = await service.validateRequest({ headers, rawBody });
    expect(result.ok).toBe(true);
    expect(result.headers.eventMessageId).toBe('evt-1');
  });

  test('rejeita assinatura inválida', async () => {
    const rawBody = Buffer.from('{"ok":true}', 'utf8');
    const headers = buildHeaders(rawBody);
    headers['Kick-Event-Signature'] = 'invalid-signature';

    const service = createKickWebhookSignatureService({
      publicKeyProvider: async () => publicKey.export({ type: 'spki', format: 'pem' }),
    });

    const result = await service.validateRequest({ headers, rawBody });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  test('rejeita corpo alterado após assinatura', async () => {
    const signedBody = Buffer.from('{"ok":true}', 'utf8');
    const tamperedBody = Buffer.from('{"ok":false}', 'utf8');
    const headers = buildHeaders(signedBody);

    const service = createKickWebhookSignatureService({
      publicKeyProvider: async () => publicKey.export({ type: 'spki', format: 'pem' }),
    });

    const result = await service.validateRequest({ headers, rawBody: tamperedBody });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  test('rejeita quando timestamp do header é alterado após assinatura', async () => {
    const rawBody = Buffer.from('{"ok":true}', 'utf8');
    const headers = buildHeaders(rawBody);
    headers['Kick-Event-Message-Timestamp'] = '2026-08-06T01:00:00.000Z';

    const service = createKickWebhookSignatureService({
      publicKeyProvider: async () => publicKey.export({ type: 'spki', format: 'pem' }),
    });

    const result = await service.validateRequest({ headers, rawBody });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  test('retorna erro de headers ausentes', async () => {
    const rawBody = Buffer.from('{}', 'utf8');
    const service = createKickWebhookSignatureService({
      publicKeyProvider: async () => publicKey.export({ type: 'spki', format: 'pem' }),
    });

    const result = await service.validateRequest({
      headers: {
        'Kick-Event-Message-Id': 'evt-2',
      },
      rawBody,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_headers');
    expect(Array.isArray(result.missingHeaders)).toBe(true);
  });
});
