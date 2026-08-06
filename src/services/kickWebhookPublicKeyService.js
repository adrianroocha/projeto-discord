class KickWebhookPublicKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KickWebhookPublicKeyError';
    this.code = code;
  }
}

function createKickWebhookPublicKeyService(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const now = options.now || (() => Date.now());
  const ttlMs = Number(options.ttlMs || 15 * 60 * 1000);
  const url = options.url || 'https://api.kick.com/public/v1/public-key';

  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API não está disponível para obter chave pública da Kick.');
  }

  let cachedPublicKey = null;
  let cacheExpiresAtMs = 0;

  function extractPublicKey(body) {
    if (!body || typeof body !== 'object') {
      return null;
    }

    if (typeof body.public_key === 'string' && body.public_key.trim()) {
      return body.public_key.trim();
    }

    if (body.data && typeof body.data === 'object') {
      if (typeof body.data.public_key === 'string' && body.data.public_key.trim()) {
        return body.data.public_key.trim();
      }
      if (typeof body.data.key === 'string' && body.data.key.trim()) {
        return body.data.key.trim();
      }
    }

    return null;
  }

  async function fetchPublicKey() {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });
    } catch (_error) {
      throw new KickWebhookPublicKeyError('PUBLIC_KEY_FETCH_FAILED', 'Falha de rede ao obter chave pública da Kick.');
    }

    if (!response.ok) {
      throw new KickWebhookPublicKeyError(
        'PUBLIC_KEY_FETCH_FAILED',
        'Resposta inválida ao obter chave pública da Kick.',
      );
    }

    let body;
    try {
      body = await response.json();
    } catch (_error) {
      throw new KickWebhookPublicKeyError(
        'PUBLIC_KEY_INVALID_RESPONSE',
        'Resposta JSON inválida ao obter chave pública da Kick.',
      );
    }

    const key = extractPublicKey(body);
    if (!key) {
      throw new KickWebhookPublicKeyError(
        'PUBLIC_KEY_INVALID_RESPONSE',
        'Chave pública ausente na resposta da Kick.',
      );
    }

    cachedPublicKey = key;
    cacheExpiresAtMs = now() + ttlMs;
    return cachedPublicKey;
  }

  async function getPublicKey() {
    if (cachedPublicKey && cacheExpiresAtMs > now()) {
      return cachedPublicKey;
    }

    return fetchPublicKey();
  }

  function invalidateCache() {
    cachedPublicKey = null;
    cacheExpiresAtMs = 0;
  }

  return {
    getPublicKey,
    invalidateCache,
  };
}

const defaultService = createKickWebhookPublicKeyService();
defaultService.createKickWebhookPublicKeyService = createKickWebhookPublicKeyService;
defaultService.KickWebhookPublicKeyError = KickWebhookPublicKeyError;

module.exports = defaultService;
