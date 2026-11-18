const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType } = require('discord.js');
const config = require('../config');

const PANEL_PREFIX = '## Vincule sua conta LivePix';
const CHANNEL_ACCESS_DENIED_CODE = 'CHANNEL_ACCESS_DENIED';

function buildPanelContent() {
  return [
    '## Vincule sua conta LivePix',
    '',
    'Vincule sua conta LivePix individualmente ao Discord.',
    '',
    'A autorização ocorre na página oficial LivePix. O bot não solicita nem armazena sua senha ou tokens.',
  ].join('\n');
}

function buildPanelActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('livepix-link-start')
      .setStyle(ButtonStyle.Primary)
      .setLabel('Vincular conta LivePix'),
    new ButtonBuilder()
      .setCustomId('livepix-link-status')
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Consultar meu vínculo'),
    new ButtonBuilder()
      .setCustomId('livepix-unlink-start')
      .setStyle(ButtonStyle.Danger)
      .setLabel('Desvincular minha conta'),
  );
}

function createLivePixLinkPanelService(options = {}) {
  const cfg = options.config || config;
  const logger = options.logger || console;

  function logInfo(message) {
    if (typeof logger?.info === 'function') logger.info(message);
  }

  function logWarn(message) {
    if (typeof logger?.warn === 'function') logger.warn(message);
  }

  function isAccessDeniedError(error) {
    return error?.code === 50001 || error?.code === 50013;
  }

  async function fetchChannel(client) {
    if (!cfg.livepixLinkChannelId) {
      logInfo('Painel LivePix Link desativado: LIVEPIX_LINK_CHANNEL_ID ausente.');
      return null;
    }

    let channel;
    try {
      channel = await client.channels.fetch(cfg.livepixLinkChannelId);
    } catch (error) {
      if (isAccessDeniedError(error)) {
        logWarn('Painel LivePix Link não inicializado: permissões insuficientes no canal. code=CHANNEL_ACCESS_DENIED');
        return { code: CHANNEL_ACCESS_DENIED_CODE };
      }
      logWarn('Painel LivePix Link não inicializado: canal inexistente.');
      return null;
    }

    if (!channel) {
      logWarn('Painel LivePix Link não inicializado: canal inexistente.');
      return null;
    }
    if (cfg.guildId && channel.guildId !== cfg.guildId) {
      logWarn('Painel LivePix Link não inicializado: canal pertence a outro servidor.');
      return null;
    }
    if (!channel.isTextBased() || channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) {
      logWarn('Painel LivePix Link não inicializado: canal não é texto de servidor.');
      return null;
    }

    const permissions = channel.permissionsFor(client.user.id);
    const hasRequiredPermissions =
      permissions &&
      permissions.has(PermissionFlagsBits.ViewChannel) &&
      permissions.has(PermissionFlagsBits.SendMessages) &&
      permissions.has(PermissionFlagsBits.ReadMessageHistory);
    if (!hasRequiredPermissions) {
      logWarn('Painel LivePix Link não inicializado: permissões insuficientes no canal.');
      return { code: CHANNEL_ACCESS_DENIED_CODE };
    }
    return channel;
  }

  async function fetchPanelMessage(channel) {
    if (channel.client.livepixLinkPanelMessageId) {
      try {
        const knownMessage = await channel.messages.fetch(channel.client.livepixLinkPanelMessageId);
        if (knownMessage && knownMessage.author.id === channel.client.user.id) return knownMessage;
      } catch {
        // fallback to history scan
      }
    }

    let before;
    while (true) {
      const optionsForFetch = { limit: 100 };
      if (before) optionsForFetch.before = before;
      const messages = await channel.messages.fetch(optionsForFetch);
      if (!messages.size) break;
      const existing = messages.find(
        (message) =>
          message.author.id === channel.client.user.id &&
          typeof message.content === 'string' &&
          message.content.startsWith(PANEL_PREFIX),
      );
      if (existing) {
        channel.client.livepixLinkPanelMessageId = existing.id;
        return existing;
      }
      before = messages.last().id;
      if (messages.size < 100) break;
    }
    return null;
  }

  async function upsertPanel(client) {
    const channel = await fetchChannel(client);
    if (channel && channel.code === CHANNEL_ACCESS_DENIED_CODE) {
      return { enabled: false, code: CHANNEL_ACCESS_DENIED_CODE };
    }
    if (!channel) return { enabled: false };

    const payload = { content: buildPanelContent(), components: [buildPanelActionRow()] };
    const existing = await fetchPanelMessage(channel);
    if (!existing) {
      const created = await channel.send(payload);
      client.livepixLinkPanelMessageId = created.id;
      return { enabled: true, created: true, messageId: created.id };
    }
    await existing.edit(payload);
    client.livepixLinkPanelMessageId = existing.id;
    return { enabled: true, created: false, messageId: existing.id };
  }

  async function initPanel(client) {
    if (client.livepixLinkPanelInitialized) return { skipped: true };
    client.livepixLinkPanelInitialized = true;
    try {
      return await upsertPanel(client);
    } catch (error) {
      logWarn(`Painel LivePix Link falhou ao inicializar: ${error?.message || 'unknown_error'}`);
      return { enabled: false, error: true };
    }
  }

  return { buildPanelContent, buildPanelActionRow, upsertPanel, initPanel };
}

const defaultService = createLivePixLinkPanelService();
defaultService.createLivePixLinkPanelService = createLivePixLinkPanelService;

module.exports = defaultService;
