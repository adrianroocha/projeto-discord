const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ChannelType } = require('discord.js');
const config = require('../config');

const PANEL_PREFIX = '## Vincule sua conta Kick';
const CHANNEL_ACCESS_DENIED_CODE = 'CHANNEL_ACCESS_DENIED';

function buildPanelContent() {
  return [
    '## Vincule sua conta Kick',
    '',
    'Vincule sua conta Kick ao Discord para que o bot possa identificar inscrições e aplicar os benefícios da comunidade.',
    '',
    'A vinculação é feita pela página oficial da Kick. O bot não solicita nem armazena sua senha.',
  ].join('\n');
}

function buildPanelActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('kick-link-start')
      .setStyle(ButtonStyle.Primary)
      .setLabel('Vincular conta Kick'),
    new ButtonBuilder()
      .setCustomId('kick_link_status')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('💚')
      .setLabel('Consultar meu vínculo'),
  );
}

function createKickLinkPanelService(options = {}) {
  const cfg = options.config || config;
  const logger = options.logger || console;

  function logInfo(message) {
    if (typeof logger?.info === 'function') {
      logger.info(message);
    }
  }

  function logWarn(message) {
    if (typeof logger?.warn === 'function') {
      logger.warn(message);
    }
  }

  function isAccessDeniedError(error) {
    return error?.code === 50001 || error?.code === 50013;
  }

  async function fetchChannel(client) {
    if (!cfg.kickLinkChannelId) {
      logInfo('Painel Kick Link desativado: KICK_LINK_CHANNEL_ID ausente.');
      return null;
    }

    let channel;
    try {
      channel = await client.channels.fetch(cfg.kickLinkChannelId);
    } catch (error) {
      if (isAccessDeniedError(error)) {
        logWarn('Painel Kick Link não inicializado: permissões insuficientes no canal. code=CHANNEL_ACCESS_DENIED');
        return { code: CHANNEL_ACCESS_DENIED_CODE };
      }
      logWarn('Painel Kick Link não inicializado: canal inexistente.');
      return null;
    }

    if (!channel) {
      logWarn('Painel Kick Link não inicializado: canal inexistente.');
      return null;
    }

    if (cfg.guildId && channel.guildId !== cfg.guildId) {
      logWarn('Painel Kick Link não inicializado: canal pertence a outro servidor.');
      return null;
    }

    if (!channel.isTextBased() || channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) {
      logWarn('Painel Kick Link não inicializado: canal não é texto de servidor.');
      return null;
    }

    const permissions = channel.permissionsFor(client.user.id);
    const hasRequiredPermissions =
      permissions &&
      permissions.has(PermissionFlagsBits.ViewChannel) &&
      permissions.has(PermissionFlagsBits.SendMessages) &&
      permissions.has(PermissionFlagsBits.ReadMessageHistory);

    if (!hasRequiredPermissions) {
      logWarn('Painel Kick Link não inicializado: permissões insuficientes no canal.');
      return { code: CHANNEL_ACCESS_DENIED_CODE };
    }

    return channel;
  }

  async function fetchPanelMessage(channel) {
    if (channel.client.kickLinkPanelMessageId) {
      try {
        const knownMessage = await channel.messages.fetch(channel.client.kickLinkPanelMessageId);
        if (knownMessage && knownMessage.author.id === channel.client.user.id) {
          return knownMessage;
        }
      } catch {
        // fallback to history scan
      }
    }

    let before;
    while (true) {
      const optionsForFetch = { limit: 100 };
      if (before) {
        optionsForFetch.before = before;
      }

      const messages = await channel.messages.fetch(optionsForFetch);
      if (!messages.size) {
        break;
      }

      const existing = messages.find(
        (message) =>
          message.author.id === channel.client.user.id &&
          typeof message.content === 'string' &&
          message.content.startsWith(PANEL_PREFIX),
      );

      if (existing) {
        channel.client.kickLinkPanelMessageId = existing.id;
        return existing;
      }

      before = messages.last().id;
      if (messages.size < 100) {
        break;
      }
    }

    return null;
  }

  async function upsertPanel(client) {
    const channel = await fetchChannel(client);
    if (channel && channel.code === CHANNEL_ACCESS_DENIED_CODE) {
      return { enabled: false, code: CHANNEL_ACCESS_DENIED_CODE };
    }

    if (!channel) {
      return { enabled: false };
    }

    const payload = {
      content: buildPanelContent(),
      components: [buildPanelActionRow()],
    };

    const existing = await fetchPanelMessage(channel);
    if (!existing) {
      const created = await channel.send(payload);
      client.kickLinkPanelMessageId = created.id;
      return { enabled: true, created: true, messageId: created.id };
    }

    await existing.edit(payload);
    client.kickLinkPanelMessageId = existing.id;
    return { enabled: true, created: false, messageId: existing.id };
  }

  async function initPanel(client) {
    if (client.kickLinkPanelInitialized) {
      return { skipped: true };
    }

    client.kickLinkPanelInitialized = true;

    try {
      return await upsertPanel(client);
    } catch (error) {
      logWarn(`Painel Kick Link falhou ao inicializar: ${error?.message || 'unknown_error'}`);
      return { enabled: false, error: true };
    }
  }

  return {
    buildPanelContent,
    buildPanelActionRow,
    upsertPanel,
    initPanel,
  };
}

const defaultService = createKickLinkPanelService();
defaultService.createKickLinkPanelService = createKickLinkPanelService;

module.exports = defaultService;
