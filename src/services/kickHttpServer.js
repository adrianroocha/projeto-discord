const http = require('http');
const config = require('../config');
const kickAuthService = require('./kickAuthService');

let server = null;
const LOOPBACK_IPV4 = '127.0.0.1';

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

function createRequestHandler(dependencies = {}) {
  const authService = dependencies.kickAuthService || kickAuthService;
  const cfg = dependencies.config || config;
  const logger = dependencies.logger || console;

  return async function requestHandler(req, res) {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${cfg.kickPort}`);

    if (req.method !== 'GET') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    if (requestUrl.pathname === '/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ status: 'ok', service: 'kick-oauth' }));
      return;
    }

    if (requestUrl.pathname === '/kick/callback') {
      const code = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');

      try {
        const result = await authService.completeOAuthCallback({ code, state });
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
  if (server) {
    return Promise.resolve({ started: false, port: options.config?.kickPort || config.kickPort });
  }

  const cfg = options.config || config;
  const logger = options.logger || console;
  const requestHandler = createRequestHandler(options);

  if (!cfg.kickEnabled && typeof logger?.info === 'function') {
    logger.info('Integração Kick desativada: variáveis obrigatórias ausentes.');
  }

  server = http.createServer((req, res) => {
    Promise.resolve(requestHandler(req, res)).catch(() => {
      res.statusCode = 500;
      res.end('Internal Server Error');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      server = null;
      reject(error);
    });

    server.listen(cfg.kickPort, LOOPBACK_IPV4, () => {
      resolve({ started: true, port: cfg.kickPort });
    });
  });
}

function stopKickHttpServer() {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const currentServer = server;
    server = null;
    currentServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
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
