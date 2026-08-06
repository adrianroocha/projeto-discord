const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const kickAuthService = require('./kickAuthService');
const kickAccountsRepository = require('../database/kickAccountsRepository');

function buildKickAuthorizeRow(authorizationUrl) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Autorizar na Kick')
      .setURL(authorizationUrl),
  );
}

function mapKickLinkError(error) {
  if (error?.code === 'KICK_OAUTH_DISABLED') {
    return 'Integração com Kick está desativada neste ambiente.';
  }

  return 'Não foi possível iniciar o vínculo com a Kick agora. Tente novamente em instantes.';
}

function createKickLinkStartService(options = {}) {
  const cfg = options.config || config;
  const authService = options.kickAuthService || kickAuthService;
  const accountsRepository = options.kickAccountsRepository || kickAccountsRepository;

  function createStartPayload(discordId) {
    if (typeof discordId !== 'string' || !discordId.trim()) {
      throw new Error('Discord ID inválido para iniciar vínculo Kick.');
    }

    if (!cfg.kickEnabled) {
      return {
        content: 'Integração com Kick está desativada neste ambiente.',
        components: [],
      };
    }

    const existingLink = accountsRepository.findByDiscordId(discordId.trim());
    if (existingLink) {
      return {
        content: `Sua conta já está vinculada: ${existingLink.kick_username} (Kick ID ${existingLink.kick_user_id}). Use /kick-status para consultar o estado atual.`,
        components: [],
      };
    }

    const attempt = authService.createAuthorizationAttempt(discordId.trim());

    return {
      content:
        'Clique no botão abaixo para autorizar a integração da Kick. O link expira em 10 minutos e solicita apenas o escopo user:read.',
      components: [buildKickAuthorizeRow(attempt.authorizationUrl)],
      expiresAtMs: attempt.expiresAtMs,
      authorizationUrl: attempt.authorizationUrl,
      ttlMs: attempt.ttlMs,
    };
  }

  return {
    createStartPayload,
    buildKickAuthorizeRow,
    mapKickLinkError,
  };
}

const defaultService = createKickLinkStartService();
defaultService.createKickLinkStartService = createKickLinkStartService;

defaultService.mapKickLinkError = mapKickLinkError;
defaultService.buildKickAuthorizeRow = buildKickAuthorizeRow;

module.exports = defaultService;
