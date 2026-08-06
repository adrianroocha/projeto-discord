const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const queueService = require('./queueService');
const queueEvents = require('./queueEvents');
const config = require('../config');

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

  const channel = await client.channels.fetch(config.queuePanelChannelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error('Canal do painel de fila não encontrado ou não é um canal de texto.');
  }

  return channel;
}

async function fetchPanelMessage(channel) {
  if (channel.client.queuePanelMessageId) {
    try {
      const message = await channel.messages.fetch(channel.client.queuePanelMessageId);
      if (message) {
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
      if (!messages.size) break;

      const panelMessage = messages.find(
        (message) =>
          message.author.id === channel.client.user.id &&
          message.content.startsWith('# 🎮 Sistema de Fila'),
      );

      if (panelMessage) {
        channel.client.queuePanelMessageId = panelMessage.id;
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

let panelUpdatePromise = Promise.resolve();

async function doUpdatePanel(client, options = {}) {
  const channel = await getQueuePanelChannel(client);
  const queueEntries = queueService.getQueue();
  const lobbies = queueService.getActiveLobbies();
  const isQueueOpen = options.isQueueOpen !== false;
  const content = buildPanelContent(lobbies, queueEntries, { isQueueOpen });
  const components = [createActionRow(isQueueOpen)];

  let message = await fetchPanelMessage(channel);
  if (!message) {
    message = await channel.send({ content, components });
    channel.client.queuePanelMessageId = message.id;
    return;
  }

  try {
    await message.edit({ content, components });
  } catch (editError) {
    console.error('Erro ao editar mensagem do painel de fila:', editError);
    message = await channel.send({ content, components });
    channel.client.queuePanelMessageId = message.id;
  }
}

async function updatePanel(client, options = {}) {
  panelUpdatePromise = panelUpdatePromise
    .then(() => doUpdatePanel(client, options))
    .catch((error) => {
      console.error('Erro na sequência de atualização do painel de fila:', error);
      throw error;
    });
  return panelUpdatePromise;
}

function startPanelUpdater(client) {
  queueEvents.on('queueUpdated', async () => {
    await updatePanel(client);
  });
}

async function initPanel(client) {
  if (!config.queuePanelChannelId) {
    console.warn('QUEUE_PANEL_CHANNEL_ID não configurado. Painel de fila não será inicializado.');
    return;
  }

  startPanelUpdater(client);
  await updatePanel(client);
}

module.exports = {
  initPanel,
  startPanelUpdater,
  updatePanel,
  buildPanelContent,
  createActionRow,
};
