const http = require('http');
const config = require('../config');
const kickAuthService = require('./kickAuthService');
const kickWebhookSignatureService = require('./kickWebhookSignatureService');
const kickSubscriptionEventService = require('./kickSubscriptionEventService');
const kickAccountsRepository = require('../database/kickAccountsRepository');
const subscriberRoleAutoSyncService = require('./subscriberRoleAutoSyncService');
const applicationLifecycleService = require('./applicationLifecycleService');

let server = null;
let closePromise = null;
let isClosing = false;
const activeSockets = new Set();
const LOOPBACK_IPV4 = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1048576;
const DEFAULT_BODY_TIMEOUT_MS = 10000;
const DEFAULT_MAX_URL_LENGTH = 8192;

function parseHeaderContentLength(rawHeaderValue) {
  if (rawHeaderValue === undefined || rawHeaderValue === null || rawHeaderValue === '') {
    return { ok: true, contentLength: null };
  }

  const normalized = Array.isArray(rawHeaderValue)
    ? String(rawHeaderValue[0] || '').trim()
    : String(rawHeaderValue).trim();

  if (!/^\d+$/.test(normalized)) {
    return { ok: false };
  }

  const contentLength = Number(normalized);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return { ok: false };
  }

  return { ok: true, contentLength };
}

function createHttpBodyError(code, statusCode, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function readRawRequestBody(req, options = {}) {
  const maxBodyBytes = Number(options.maxBodyBytes) || DEFAULT_MAX_BODY_BYTES;
  const bodyTimeoutMs = Number(options.bodyTimeoutMs) || DEFAULT_BODY_TIMEOUT_MS;
  const parsedContentLength = parseHeaderContentLength(req?.headers?.['content-length']);

  if (!parsedContentLength.ok) {
    throw createHttpBodyError('invalid_content_length', 400);
  }

  if (parsedContentLength.contentLength !== null && parsedContentLength.contentLength > maxBodyBytes) {
    throw createHttpBodyError('payload_too_large', 413, {
      observedBytes: parsedContentLength.contentLength,
      limitBytes: maxBodyBytes,
      source: 'content_length',
    });
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      clearTimeout(timeoutTimer);
    }

    function settleWithError(error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function settleWithBody() {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    }

    function onData(chunk) {
      if (settled) {
        return;
      }

      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextTotalBytes = totalBytes + chunkBuffer.length;

      if (nextTotalBytes > maxBodyBytes) {
        settleWithError(
          createHttpBodyError('payload_too_large', 413, {
            observedBytes: nextTotalBytes,
            limitBytes: maxBodyBytes,
            source: 'stream',
          }),
        );
        return;
      }

      totalBytes = nextTotalBytes;
      chunks.push(chunkBuffer);
    }

    function onEnd() {
      settleWithBody();
    }

    function onError(_error) {
      settleWithError(createHttpBodyError('stream_error', 400));
    }

    function onAborted() {
      settleWithError(createHttpBodyError('stream_aborted', 400));
    }

    const timeoutTimer = setTimeout(() => {
      settleWithError(
        createHttpBodyError('request_timeout', 408, {
          limitMs: bodyTimeoutMs,
        }),
      );
    }, bodyTimeoutMs);

    if (typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref();
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function respondText(res, statusCode, body) {
  if (res.writableEnded) {
    return;
  }

  res.statusCode = statusCode;
  res.end(body);
}

function finalizeRejectedRequest(req, res, statusCode, body) {
  if (res.writableEnded) {
    return;
  }

  res.statusCode = statusCode;
  res.setHeader('Connection', 'close');
  res.end(body);

  // Consume and discard any remaining request bytes without buffering them.
  if (req && !req.destroyed && typeof req.resume === 'function') {
    req.resume();
  }
}

function logHttpRejection(logger, details) {
  if (typeof logger?.warn !== 'function') {
    return;
  }

  const reason = details?.reason || 'unknown';
  const route = details?.route || 'unknown';
  const statusCode = Number(details?.statusCode) || 0;
  const observedBytes = Number.isFinite(details?.observedBytes) ? ` observed_bytes=${details.observedBytes}` : '';
  const limitBytes = Number.isFinite(details?.limitBytes) ? ` limit_bytes=${details.limitBytes}` : '';
  const limitMs = Number.isFinite(details?.limitMs) ? ` limit_ms=${details.limitMs}` : '';

  logger.warn(
    `Kick HTTP rejeição: reason=${reason} route=${route} status=${statusCode}${observedBytes}${limitBytes}${limitMs}`,
  );
}

function getSafePositiveInteger(value, fallback) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  return fallback;
}

function getLifecycleState(lifecycleService) {
  const state = lifecycleService?.getState?.()?.state;
  if (typeof state === 'string' && state.trim()) {
    return state.trim();
  }
  return lifecycleService?.isShuttingDown?.() ? 'shutting_down' : 'starting';
}

function writeHtml(res, statusCode, title, message) {
  const body = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: sans-serif; max-width: 680px; margin: 40px auto; padding: 0 16px; color: #1f2937; }
      .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; }
      h1 { margin-top: 0; font-size: 1.25rem; }
      p { line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${message}</p>
      <p>Agora você pode voltar ao Discord.</p>
    </div>
  </body>
</html>`;

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(body);
}

function mapCallbackError(error) {
  if (!error || typeof error !== 'object') {
    return { statusCode: 500, title: 'Erro interno', message: 'Não foi possível concluir o vínculo com a Kick.' };
  }

  if (error.code === 'MISSING_CODE' || error.code === 'MISSING_STATE') {
    return { statusCode: 400, title: 'Parâmetros inválidos', message: 'A solicitação de vínculo está incompleta ou inválida.' };
  }

  if (error.code === 'STATE_INVALID' || error.code === 'STATE_EXPIRED' || error.code === 'STATE_REUSED') {
    return {
      statusCode: 400,
      title: 'Link inválido ou expirado',
      message: 'O link de vínculo está inválido, expirado ou já foi utilizado.',
    };
  }

  if (error.code === 'KICK_ACCOUNT_CONFLICT') {
    return {
      statusCode: 409,
      title: 'Conta Kick já vinculada',
      message: 'Esta conta Kick já está vinculada a outro usuário do Discord.',
    };
  }

  if (error.code === 'KICK_OAUTH_DISABLED') {
    return {
      statusCode: 503,
      title: 'Integração indisponível',
      message: 'A integração da Kick está desativada neste ambiente.',
    };
  }

  if (typeof error.httpStatus === 'number' && error.httpStatus >= 400) {
    if (error.httpStatus === 429) {
      return { statusCode: 429, title: 'Muitas tentativas', message: 'A Kick limitou temporariamente as requisições. Tente novamente.' };
    }

    if (error.httpStatus === 401 || error.httpStatus === 403) {
      return { statusCode: error.httpStatus, title: 'Falha de autorização', message: 'Não foi possível autorizar sua conta Kick.' };
    }

    if (error.httpStatus >= 500) {
      return { statusCode: 502, title: 'Serviço indisponível', message: 'Serviço da Kick indisponível no momento. Tente novamente mais tarde.' };
    }

    return { statusCode: error.httpStatus, title: 'Falha na integração', message: 'Não foi possível concluir a integração com a Kick.' };
  }

  return { statusCode: 500, title: 'Erro interno', message: 'Não foi possível concluir o vínculo com a Kick.' };
}

function normalizeWebhookEventType(eventType) {
  if (typeof eventType !== 'string') {
    return '';
  }

  return eventType.trim().toLowerCase();
}

function buildSafeWebhookDiagnostic({ eventType, eventVersion, eventPayload, finalCode }) {
  const normalizedType = normalizeWebhookEventType(eventType) || 'unknown';
  const normalizedVersion = typeof eventVersion === 'string' && eventVersion.trim() ? eventVersion.trim() : 'unknown';
  const payload = eventPayload && typeof eventPayload === 'object' ? eventPayload : null;
  const hasBroadcaster = Boolean(payload?.broadcaster && typeof payload.broadcaster === 'object');
  const hasSubscriber = Boolean(payload?.subscriber && typeof payload.subscriber === 'object');
  const hasFollower = Boolean(payload?.follower && typeof payload.follower === 'object');
  const hasGiftees = Array.isArray(payload?.giftees) && payload.giftees.length > 0;

  return [
    `event_type=${normalizedType}`,
    `version=${normalizedVersion}`,
    `broadcaster=${hasBroadcaster ? 'present' : 'absent'}`,
    `subscriber=${hasSubscriber ? 'present' : 'absent'}`,
    `follower=${hasFollower ? 'present' : 'absent'}`,
    `giftees=${hasGiftees ? 'present' : 'absent'}`,
    `code=${finalCode || 'unknown'}`,
  ].join(' ');
}

function mapWebhookEventTypeToTriggerType(eventType) {
  const normalized = normalizeWebhookEventType(eventType);
  const map = {
    'channel.subscription.new': 'kick_subscription_new',
    'channel.subscription.renewal': 'kick_subscription_renewal',
    'channel.subscription.gifts': 'kick_subscription_gift',
  };

  return map[normalized] || null;
}

function collectKickUserIdsForSync(eventType, eventPayload) {
  if (!eventPayload || typeof eventPayload !== 'object') {
    return [];
  }

  if (eventType === 'channel.subscription.gifts') {
    if (!Array.isArray(eventPayload.giftees)) {
      return [];
    }

    return eventPayload.giftees
      .map((giftee) => (typeof giftee?.user_id === 'string' ? giftee.user_id.trim() : ''))
      .filter(Boolean);
  }

  if (eventType === 'channel.subscription.new' || eventType === 'channel.subscription.renewal') {
    const kickUserId =
      typeof eventPayload?.subscriber?.user_id === 'string' ? eventPayload.subscriber.user_id.trim() : '';
    return kickUserId ? [kickUserId] : [];
  }

  return [];
}

function createRequestHandler(dependencies = {}) {
  const authService = dependencies.kickAuthService || kickAuthService;
  const webhookSignatureService =
    dependencies.kickWebhookSignatureService || kickWebhookSignatureService;
  const subscriptionEventService =
    dependencies.kickSubscriptionEventService || kickSubscriptionEventService;
  const accountsRepository = dependencies.kickAccountsRepository || kickAccountsRepository;
  const autoSyncService =
    dependencies.subscriberRoleAutoSyncService || subscriberRoleAutoSyncService;
  const discordClient = dependencies.discordClient;
  const cfg = dependencies.config || config;
  const logger = dependencies.logger || console;
  const lifecycleService = dependencies.applicationLifecycleService || applicationLifecycleService;
  const maxBodyBytes = getSafePositiveInteger(cfg.kickHttpMaxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  const bodyTimeoutMs = getSafePositiveInteger(cfg.kickHttpBodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS);
  const maxUrlLength = getSafePositiveInteger(cfg.kickHttpMaxUrlLength, DEFAULT_MAX_URL_LENGTH);

  function logWebhookCategory(statusOrCode) {
    if (!statusOrCode) {
      return;
    }

    const categoryMap = {
      processed: 'processed',
      duplicate: 'duplicate',
      ignored_other_broadcaster: 'wrong_broadcaster',
      invalid_event_timestamp: 'invalid_event_timestamp',
      invalid_follower: 'invalid_follower',
      database_error: 'database_error',
    };

    const mapped = categoryMap[statusOrCode] || statusOrCode;
    if (typeof logger?.info === 'function') {
      logger.info(`Kick webhook status: ${mapped}`);
    }
  }

  return async function requestHandler(req, res) {
    if (lifecycleService.isShuttingDown()) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Service Unavailable');
      return;
    }

    const rawUrl = typeof req.url === 'string' ? req.url : '/';
    const observedUrlLength = Buffer.byteLength(rawUrl, 'utf8');
    if (observedUrlLength > maxUrlLength) {
      const routePath = rawUrl.split('?')[0] || '/';
      logHttpRejection(logger, {
        reason: 'uri_too_long',
        route: routePath,
        statusCode: 414,
        observedBytes: observedUrlLength,
        limitBytes: maxUrlLength,
      });
      finalizeRejectedRequest(req, res, 414, 'URI Too Long');
      return;
    }

    const requestUrl = new URL(rawUrl, `http://127.0.0.1:${cfg.kickPort}`);

    if (requestUrl.pathname === '/kick/webhooks') {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return;
      }

      let rawBody;
      try {
        rawBody = await readRawRequestBody(req, {
          maxBodyBytes,
          bodyTimeoutMs,
        });
      } catch (error) {
        if (error?.statusCode === 413) {
          logHttpRejection(logger, {
            reason: error.code || 'payload_too_large',
            route: requestUrl.pathname,
            statusCode: 413,
            observedBytes: error.observedBytes,
            limitBytes: error.limitBytes || maxBodyBytes,
          });
          finalizeRejectedRequest(req, res, 413, 'Payload Too Large');
          return;
        }

        if (error?.statusCode === 408) {
          logHttpRejection(logger, {
            reason: error.code || 'request_timeout',
            route: requestUrl.pathname,
            statusCode: 408,
            limitMs: error.limitMs || bodyTimeoutMs,
          });
          finalizeRejectedRequest(req, res, 408, 'Request Timeout');
          return;
        }

        if (error?.statusCode === 400) {
          logHttpRejection(logger, {
            reason: error.code || 'bad_request',
            route: requestUrl.pathname,
            statusCode: 400,
          });
          finalizeRejectedRequest(req, res, 400, 'Bad Request');
          return;
        }

        finalizeRejectedRequest(req, res, 500, 'Internal Server Error');
        return;
      }

      let signatureValidation;
      try {
        signatureValidation = await webhookSignatureService.validateRequest({
          headers: req.headers,
          rawBody,
        });
      } catch (error) {
        if (typeof logger?.warn === 'function') {
          logger.warn(`Kick webhook assinatura indisponível: ${error?.code || 'unknown'}`);
        }
        res.statusCode = 500;
        res.end('Internal Server Error');
        return;
      }

      if (!signatureValidation.ok) {
        if (signatureValidation.reason === 'missing_headers') {
          respondText(res, 400, 'Bad Request');
          return;
        }

        respondText(res, 401, 'Unauthorized');
        return;
      }

      let eventPayload;
      try {
        eventPayload = JSON.parse(rawBody.toString('utf8'));
      } catch (_error) {
        const diagnostic = buildSafeWebhookDiagnostic({
          eventType: signatureValidation?.headers?.eventType,
          eventVersion: signatureValidation?.headers?.eventVersion,
          eventPayload: null,
          finalCode: 'invalid_json',
        });
        if (typeof logger?.warn === 'function') {
          logger.warn(`Kick webhook diagnostic: ${diagnostic}`);
        }
        respondText(res, 400, 'Bad Request');
        return;
      }

      try {
        const result = subscriptionEventService.processEvent({
          eventHeaders: signatureValidation.headers,
          eventPayload,
        });

        if (result.status === 'processed') {
          const eventType = signatureValidation.headers?.eventType;
          const triggerType = mapWebhookEventTypeToTriggerType(eventType);

          if (triggerType) {
            const kickUserIds = collectKickUserIdsForSync(eventType, eventPayload);
            const targetDiscordIds = new Set();

            for (const kickUserId of kickUserIds) {
              const link = accountsRepository.findByKickUserId(kickUserId);
              if (!link?.discord_id) {
                if (typeof logger?.info === 'function') {
                  logger.info(`Webhook ${eventType}: kick_user_id sem vínculo Discord local.`);
                }
                continue;
              }

              targetDiscordIds.add(link.discord_id);
            }

            for (const discordId of targetDiscordIds) {
              try {
                const syncResult = await autoSyncService.syncAfterEligibilityChange({
                  discordId,
                  triggerType,
                  reason: `Webhook Kick ${eventType}`,
                  triggeredByDiscordId: 'system',
                  client: discordClient,
                });

                if (syncResult.status === 'warning' && typeof logger?.warn === 'function') {
                  logger.warn(
                    `Webhook ${eventType}: sincronização pendente para discordId=${discordId}; usar /sub-sync para reconciliação.`,
                  );
                }
              } catch (_error) {
                if (typeof logger?.warn === 'function') {
                  logger.warn(
                    `Webhook ${eventType}: falha inesperada na sincronização para discordId=${discordId}; usar /sub-sync para reconciliação.`,
                  );
                }
              }
            }
          }
        }

        logWebhookCategory(result?.status);

        if (
          result.status === 'processed' ||
          result.status === 'duplicate' ||
          result.status === 'ignored_other_broadcaster' ||
          result.status === 'ignored_unsupported'
        ) {
          const diagnostic = buildSafeWebhookDiagnostic({
            eventType: signatureValidation?.headers?.eventType,
            eventVersion: signatureValidation?.headers?.eventVersion,
            eventPayload,
            finalCode: result?.status || 'processed',
          });
          if (typeof logger?.info === 'function') {
            logger.info(`Kick webhook diagnostic: ${diagnostic}`);
          }
          res.statusCode = 204;
          res.end('');
          return;
        }

        if (result.status === 'webhook_disabled_unconfigured') {
          res.statusCode = 503;
          res.end('Service Unavailable');
          return;
        }

        res.statusCode = 500;
        res.end('Internal Server Error');
      } catch (error) {
        const diagnostic = buildSafeWebhookDiagnostic({
          eventType: signatureValidation?.headers?.eventType,
          eventVersion: signatureValidation?.headers?.eventVersion,
          eventPayload,
          finalCode: error?.code || 'processing_error',
        });
        if (typeof logger?.warn === 'function') {
          logger.warn(`Kick webhook diagnostic: ${diagnostic}`);
        }
        logWebhookCategory(error?.code || 'processing_error');
        const isClientError =
          error?.code === 'invalid_payload' ||
          error?.code === 'invalid_follower' ||
          error?.code === 'invalid_event_timestamp' ||
          /Campo inválido:/.test(error?.message || '');
        res.statusCode = isClientError ? 400 : 500;
        res.end(isClientError ? 'Bad Request' : 'Internal Server Error');
      }
      return;
    }

    if (req.method !== 'GET') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    if (requestUrl.pathname === '/health') {
      const state = getLifecycleState(lifecycleService);
      const isReady = state === 'ready';

      res.statusCode = isReady ? 200 : 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify(
          isReady
            ? { status: 'ready', state: 'ready' }
            : { status: 'unavailable', state },
        ),
      );
      return;
    }

    if (requestUrl.pathname === '/kick/callback') {
      const code = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');

      try {
        const result = await authService.completeOAuthCallback({ code, state, discordClient });
        writeHtml(
          res,
          200,
          'Conta Kick vinculada com sucesso',
          `Vínculo concluído para a conta Kick ${result.kickUsername}.`,
        );
      } catch (error) {
        const safeError = mapCallbackError(error);
        if (typeof logger?.warn === 'function') {
          const category = error?.category || error?.code || 'unknown_error';
          logger.warn(`Kick OAuth callback falhou: ${category}`);
        }
        writeHtml(res, safeError.statusCode, safeError.title, safeError.message);
      }
      return;
    }

    res.statusCode = 404;
    res.end('Not Found');
  };
}

function startKickHttpServer(options = {}) {
  if (applicationLifecycleService.isShuttingDown()) {
    return Promise.resolve({ started: false, port: options.config?.kickPort || config.kickPort });
  }

  if (server || isClosing) {
    return Promise.resolve({ started: false, port: options.config?.kickPort || config.kickPort });
  }

  const cfg = options.config || config;
  const logger = options.logger || console;
  const requestHandler = createRequestHandler(options);
  const host = typeof cfg.kickHost === 'string' && cfg.kickHost.trim() ? cfg.kickHost.trim() : LOOPBACK_IPV4;

  if (!cfg.kickEnabled && typeof logger?.info === 'function') {
    logger.info('Integração Kick desativada: variáveis obrigatórias ausentes.');
  }

  server = http.createServer((req, res) => {
    Promise.resolve(requestHandler(req, res)).catch(() => {
      res.statusCode = 500;
      res.end('Internal Server Error');
    });
  });

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => {
      activeSockets.delete(socket);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      server = null;
      reject(error);
    });

    server.listen(cfg.kickPort, host, () => {
      resolve({ started: true, port: cfg.kickPort, host });
    });
  });
}

function stopKickHttpServer() {
  if (closePromise) {
    return closePromise;
  }

  if (!server) {
    return Promise.resolve();
  }

  isClosing = true;
  closePromise = new Promise((resolve, reject) => {
    const currentServer = server;
    server = null;

    const forceSocketCloseTimer = setTimeout(() => {
      for (const socket of activeSockets) {
        try {
          socket.destroy();
        } catch (_error) {
          // best-effort
        }
      }
    }, 1_000);

    if (typeof forceSocketCloseTimer.unref === 'function') {
      forceSocketCloseTimer.unref();
    }

    currentServer.close((error) => {
      clearTimeout(forceSocketCloseTimer);
      if (error) {
        closePromise = null;
        isClosing = false;
        reject(error);
        return;
      }
      closePromise = null;
      isClosing = false;
      resolve();
    });
  });

  return closePromise;
}

function getKickHttpServerInstance() {
  return server;
}

module.exports = {
  createRequestHandler,
  startKickHttpServer,
  stopKickHttpServer,
  getKickHttpServerInstance,
  mapCallbackError,
};
