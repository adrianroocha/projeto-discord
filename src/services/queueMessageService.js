const { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = require('discord.js');
const queueService = require('./queueService');
const queueEvents = require('./queueEvents');
const config = require('../config');
const lifecycleService = require('./applicationLifecycleService');

const CHANNEL_ACCESS_DENIED_CODE = 'CHANNEL_ACCESS_DENIED';

function buildPanelContent(allLobbies, queueEntries, options = {}) {
  const isQueueOpen = options.isQueueOpen !== false;
  const lines = [
    '# 🎮 Sistema de Fila',
  ];

  if (!isQueueOpen) {
    lines.push('🔒 Fila fechada no momento.');
  }

  lines.push(
    '⏳ Após entrar na fila, é necessário aguardar 2 minutos antes de poder sair.',
    '.',
    '👥 Jogadores em espera',
    '',
  );

  if (!queueEntries.length) {
    lines.push('Nenhum jogador aguardando.');
  } else {
    queueEntries.forEach((entry, index) => {
      const position = index + 1;
      const name = entry.display_name?.trim() ? entry.display_name : entry.username;
      const subscriberTag = entry.is_subscriber ? ' (Sub)👑' : '';
      lines.push(`${position}. ${name}${subscriberTag}`);
    });
  }

  lines.push('', '━━━━━━━━━━━━━━━━', '');
  lines.push('🧩 Lobbies em formação', '');

  const forming = allLobbies.filter((l) => l.status === 'forming');
  if (!forming.length) {
    lines.push('Nenhum lobby em formação.');
  } else {
    forming.forEach((lobby, idx) => {
      lines.push(`Lobby #${lobby.lobbyNumber}`);
      lobby.players.forEach((player) => {
        const name = player.displayName?.trim() ? player.displayName : player.username;
        const subscriberTag = player.isSubscriber ? ' (Sub)👑' : '';
        lines.push(`${name}${subscriberTag}`);
      });
      if (idx < forming.length - 1) {
        lines.push('', '━━━━━━━━━━━━━━━━', '');
      }
    });
  }

  lines.push('', '━━━━━━━━━━━━━━━━', '');
  lines.push('🔥 Lobbies ativas', '');

  const inGame = allLobbies.filter((l) => l.status === 'in_game');
  if (!inGame.length) {
    lines.push('Nenhum lobby ativa.');
  } else {
    inGame.forEach((lobby, idx) => {
      lines.push(`Lobby #${lobby.lobbyNumber}`);
      lobby.players.forEach((player) => {
        const name = player.displayName?.trim() ? player.displayName : player.username;
        const subscriberTag = player.isSubscriber ? ' (Sub)👑' : '';
        lines.push(`${name}${subscriberTag}`);
      });
      if (idx < inGame.length - 1) {
        lines.push('', '━━━━━━━━━━━━━━━━', '');
      }
    });
  }

  lines.push('.');
  return lines.join('\n');
}

function createActionRow(isQueueOpen) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('join_queue')
      .setLabel(' 🎮 Entrar na fila')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!isQueueOpen),
    new ButtonBuilder()
      .setCustomId('leave_queue')
      .setLabel('❌ Sair da fila')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!isQueueOpen),
  );
}

async function getQueuePanelChannel(client) {
  if (!config.queuePanelChannelId) {
    throw new Error('Variável de ambiente QUEUE_PANEL_CHANNEL_ID não configurada.');
  }

  let channel;
  try {
    channel = await client.channels.fetch(config.queuePanelChannelId);
  } catch (error) {
    if (isIgnorablePanelError(error)) {
      const denied = new Error('Sem acesso ao canal do painel de fila.');
      denied.code = CHANNEL_ACCESS_DENIED_CODE;
      throw denied;
    }
    throw error;
  }

  if (!channel || !channel.isTextBased()) {
    throw new Error('Canal do painel de fila não encontrado ou não é um canal de texto.');
  }

  return channel;
}

function isPanelMessage(message, channelClient) {
  if (!message || !channelClient?.user?.id) {
    return false;
  }

  return message.author?.id === channelClient.user.id && message.content?.startsWith('# 🎮 Sistema de Fila');
}

async function fetchPanelMessage(channel) {
  const channelClient = channel?.client;

  if (channelClient?.queuePanelMessageId) {
    try {
      const message = await channel.messages.fetch(channelClient.queuePanelMessageId);
      if (message && isPanelMessage(message, channelClient)) {
        return message;
      }
    } catch (error) {
      // continue to fallback search
    }
  }

  try {
    let lastId = null;
    while (true) {
      const options = { limit: 100 };
      if (lastId) {
        options.before = lastId;
      }

      const messages = await channel.messages.fetch(options);
      if (!messages || !messages.size) break;

      const panelMessage = messages.find((message) => isPanelMessage(message, channelClient));

      if (panelMessage) {
        channelClient.queuePanelMessageId = panelMessage.id;
        return panelMessage;
      }

      lastId = messages.last().id;
      if (messages.size < 100) break;
    }
  } catch (error) {
    console.error('Erro ao buscar mensagem do painel de fila:', error);
  }

  return null;
}

function isRecoverablePanelError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  if (error.code === 10008) {
    return true;
  }

  const message = String(error.message || '').toLowerCase();
  return message.includes('unknown message') || message.includes('message not found') || message.includes('not found');
}

function isPanelRecoveryAllowed() {
  if (lifecycleService.isShuttingDown?.()) {
    return false;
  }

  const state = lifecycleService.getState?.()?.state;
  if (state === 'stopped' || state === 'failed') {
    return false;
  }

  return true;
}

function isIgnorablePanelError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  if (error.code === 50013 || error.code === 50001) {
    return true;
  }

  return false;
}

let panelUpdatePromise = Promise.resolve();
let panelRecoveryPromise = Promise.resolve();

async function recoverPanelMessage(channel, payload, options = {}) {
  const channelClient = channel?.client;
  if (!channelClient || !isPanelRecoveryAllowed()) {
    return null;
  }

  const forceCreate = Boolean(options.forceCreate);

  const currentRecoverPromise = panelRecoveryPromise
    .then(async () => {
      const existingMessage = forceCreate ? null : await fetchPanelMessage(channel);
      if (!existingMessage) {
        const createdMessage = await channel.send(payload);
        channelClient.queuePanelMessageId = createdMessage.id;
        return createdMessage;
      }

      try {
        await existingMessage.edit(payload);
        channelClient.queuePanelMessageId = existingMessage.id;
        return existingMessage;
      } catch (editError) {
        if (!isRecoverablePanelError(editError)) {
          if (isIgnorablePanelError(editError)) {
            console.warn('Painel de fila não pode ser atualizado por permissão/escopo:', editError.code);
            return existingMessage;
          }
          throw editError;
        }

        channelClient.queuePanelMessageId = null;
        const createdMessage = await channel.send(payload);
        channelClient.queuePanelMessageId = createdMessage.id;
        return createdMessage;
      }
    })
    .catch((error) => {
      if (isIgnorablePanelError(error)) {
        console.warn('Painel de fila não pode ser atualizado por permissão/escopo:', error.code);
        return null;
      }
      throw error;
    });

  panelRecoveryPromise = currentRecoverPromise.catch(() => null);
  return currentRecoverPromise;
}

async function doUpdatePanel(client, options = {}) {
  const channel = await getQueuePanelChannel(client);
  const queueEntries = queueService.getQueue();
  const lobbies = queueService.getActiveLobbies();
  const isQueueOpen = options.isQueueOpen !== false;
  const content = buildPanelContent(lobbies, queueEntries, { isQueueOpen });
  const components = [createActionRow(isQueueOpen)];

  const payload = { content, components };
  const message = await recoverPanelMessage(channel, payload);
  if (message) {
    channel.client.queuePanelMessageId = message.id;
    return { updated: true };
  }

  return { updated: false, code: CHANNEL_ACCESS_DENIED_CODE };
}

async function updatePanel(client, options = {}) {
  panelUpdatePromise = panelUpdatePromise
    .then(() => doUpdatePanel(client, options))
    .catch((error) => {
      if (error?.code === CHANNEL_ACCESS_DENIED_CODE) {
        console.warn('Painel de fila não inicializado/atualizado: acesso insuficiente ao canal.');
        return { updated: false, code: CHANNEL_ACCESS_DENIED_CODE };
      }
      console.error('Erro na sequência de atualização do painel de fila:', error);
      throw error;
    });
  return panelUpdatePromise;
}

function startPanelUpdater(client) {
  if (client.__queuePanelUpdaterRegistered) {
    return;
  }

  client.__queuePanelUpdaterRegistered = true;
  queueEvents.on('queueUpdated', async () => {
    if (lifecycleService.isShuttingDown?.()) {
      return;
    }

    await updatePanel(client);
  });
}

function registerPanelMessageDeleteHandler(client) {
  if (client.__queuePanelDeleteHandlerRegistered) {
    return;
  }

  client.__queuePanelDeleteHandlerRegistered = true;
  client.on(Events.MessageDelete, async (message) => {
    if (!message || lifecycleService.isShuttingDown?.()) {
      return;
    }

    if (!message.channel || !message.channel.isTextBased?.()) {
      return;
    }

    if (!config.queuePanelChannelId || String(message.channel.id) !== String(config.queuePanelChannelId)) {
      return;
    }

    if (!message.author || message.author.id !== client.user?.id) {
      return;
    }

    const channelClient = message.channel.client;
    if (!channelClient || !message.content?.startsWith('# 🎮 Sistema de Fila')) {
      return;
    }

    if (channelClient.queuePanelMessageId && String(channelClient.queuePanelMessageId) !== String(message.id)) {
      return;
    }

    channelClient.queuePanelMessageId = null;

    let payload;
    try {
      const queueEntries = queueService.getQueue();
      const lobbies = queueService.getActiveLobbies();
      const isQueueOpen = true;
      const content = buildPanelContent(lobbies, queueEntries, { isQueueOpen });
      const components = [createActionRow(isQueueOpen)];
      payload = { content, components };
    } catch (error) {
      console.warn('Não foi possível reconstruir o painel de fila após exclusão, usando fallback seguro:', error.message);
      payload = {
        content: buildPanelContent([], [], { isQueueOpen: true }),
        components: [createActionRow(true)],
      };
    }

    await recoverPanelMessage(message.channel, payload, { forceCreate: true });
  });
}

async function initPanel(client) {
  if (!config.queuePanelChannelId) {
    console.warn('QUEUE_PANEL_CHANNEL_ID não configurado. Painel de fila não será inicializado.');
    return { enabled: false, code: 'QUEUE_PANEL_DISABLED' };
  }

  startPanelUpdater(client);
  registerPanelMessageDeleteHandler(client);
  const result = await updatePanel(client);
  if (result && result.code === CHANNEL_ACCESS_DENIED_CODE) {
    return { enabled: false, code: CHANNEL_ACCESS_DENIED_CODE };
  }

  return { enabled: true };
}

module.exports = {
  initPanel,
  startPanelUpdater,
  registerPanelMessageDeleteHandler,
  updatePanel,
  recoverPanelMessage,
  buildPanelContent,
  createActionRow,
};
