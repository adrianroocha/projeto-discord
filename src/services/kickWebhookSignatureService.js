const crypto = require('crypto');
const kickWebhookPublicKeyService = require('./kickWebhookPublicKeyService');

const REQUIRED_HEADERS = [
  'kick-event-message-id',
  'kick-event-subscription-id',
  'kick-event-signature',
  'kick-event-message-timestamp',
  'kick-event-type',
  'kick-event-version',
];

function createKickWebhookSignatureService(options = {}) {
  const publicKeyProvider =
    options.publicKeyProvider ||
    (() => kickWebhookPublicKeyService.getPublicKey());

  function normalizeHeaders(rawHeaders) {
    const normalized = {};
    for (const [key, value] of Object.entries(rawHeaders || {})) {
      normalized[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    return normalized;
  }

  function extractHeaders(rawHeaders) {
    const headers = normalizeHeaders(rawHeaders);
    const missingHeaders = REQUIRED_HEADERS.filter((name) => {
      const value = headers[name];
      return typeof value !== 'string' || !value.trim();
    });

    if (missingHeaders.length > 0) {
      return { ok: false, reason: 'missing_headers', missingHeaders };
    }

    return {
      ok: true,
      headers: {
        eventMessageId: headers['kick-event-message-id'].trim(),
        eventSubscriptionId: headers['kick-event-subscription-id'].trim(),
        eventSignature: headers['kick-event-signature'].trim(),
        eventTimestamp: headers['kick-event-message-timestamp'].trim(),
        eventType: headers['kick-event-type'].trim(),
        eventVersion: headers['kick-event-version'].trim(),
      },
    };
  }

  function buildSignedPayload(headers, rawBody) {
    return Buffer.concat([
      Buffer.from(`${headers.eventMessageId}.${headers.eventTimestamp}.`, 'utf8'),
      rawBody,
    ]);
  }

  function decodeSignature(signatureBase64) {
    try {
      return Buffer.from(signatureBase64, 'base64');
    } catch {
      return null;
    }
  }

  async function validateRequest(payload) {
    const rawBody = payload?.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      throw new Error('Parâmetro inválido: rawBody deve ser Buffer.');
    }

    const extracted = extractHeaders(payload?.headers);
    if (!extracted.ok) {
      return extracted;
    }

    let publicKey;
    try {
      publicKey = await publicKeyProvider();
    } catch (error) {
      const wrapped = new Error('Falha ao obter chave pública da Kick para validação.');
      wrapped.code = error?.code || 'PUBLIC_KEY_UNAVAILABLE';
      throw wrapped;
    }

    const signatureBuffer = decodeSignature(extracted.headers.eventSignature);
    if (!signatureBuffer || signatureBuffer.length === 0) {
      return { ok: false, reason: 'invalid_signature' };
    }

    const signedPayload = buildSignedPayload(extracted.headers, rawBody);
    const verified = crypto.verify(
      'RSA-SHA256',
      signedPayload,
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      signatureBuffer,
    );

    if (!verified) {
      return { ok: false, reason: 'invalid_signature' };
    }

    return {
      ok: true,
      headers: extracted.headers,
    };
  }

  return {
    validateRequest,
    extractHeaders,
  };
}

const defaultService = createKickWebhookSignatureService();
defaultService.createKickWebhookSignatureService = createKickWebhookSignatureService;

module.exports = defaultService;
