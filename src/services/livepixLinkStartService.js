const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const livepixLinkAuthService = require('./livepixLinkAuthService');
const livepixAccountsRepository = require('../database/livepixAccountsRepository');

function buildAuthorizeRow(authorizationUrl) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Autorizar na LivePix')
      .setURL(authorizationUrl),
  );
}

function createLivePixLinkStartService(options = {}) {
  const cfg = options.config || config;
  const authService = options.livepixLinkAuthService || livepixLinkAuthService;
  const repository = options.livepixAccountsRepository || livepixAccountsRepository;
  const logger = options.logger || console;

  function createStartPayload(discordId) {
    if (typeof discordId !== 'string' || !discordId.trim()) {
      throw new Error('Discord ID inválido para iniciar vínculo LivePix.');
    }

    const existing = repository.findByDiscordId(discordId.trim());
    if (existing) {
      return {
        content: 'Sua conta LivePix já está vinculada. Consulte o painel para verificar ou desvincular.',
        components: [],
      };
    }

    const attempt = authService.createAuthorizationAttempt(discordId.trim());
    return {
      content: 'Autorize o acesso à sua conta na página oficial LivePix. O link expira em 10 minutos.',
      components: [buildAuthorizeRow(attempt.authorizationUrl)],
      expiresAtMs: attempt.expiresAtMs,
      authorizationUrl: attempt.authorizationUrl,
    };
  }

  function mapError(error) {
    if (!authService.isEnabled()) {
      return 'A vinculação individual LivePix não está configurada neste ambiente.';
    }
    if (typeof logger?.warn === 'function') {
      logger.warn(`LivePix OAuth não iniciado: ${error?.code || error?.name || 'unknown_error'}`);
    }
    return 'Não foi possível iniciar o vínculo LivePix agora. Tente novamente em instantes.';
  }

  return { createStartPayload, buildAuthorizeRow, mapError, config: cfg };
}

const defaultService = createLivePixLinkStartService();
defaultService.createLivePixLinkStartService = createLivePixLinkStartService;

module.exports = defaultService;
