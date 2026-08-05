const { SlashCommandBuilder } = require('discord.js');
const queueService = require('../services/queueService');

function formatPlayerLine(player) {
  const name = player.displayName?.trim() ? player.displayName : player.username;
  const subscriberTag = player.isSubscriber ? ' (SUB)' : '';
  return `${player.isSubscriber ? '👑 ' : ''}${name}${subscriberTag}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lobby-status')
    .setDescription('Mostra os lobbies ativos registrados no banco de dados.'),

  async execute(interaction) {
    const lobbies = queueService.getActiveLobbies();

    if (!lobbies.length) {
      await interaction.reply({
        content: '🎯 Nenhum lobby ativo no momento.',
        ephemeral: true,
      });
      return;
    }

    const lines = ['🎯 Lobbies ativos', '', '━━━━━━━━━━━━━━', ''];

    lobbies.forEach((lobby, index) => {
      const statusLabel = lobby.status === 'open' ? 'aguardando partida' : lobby.status;
      lines.push(`Lobby #${index + 1}`, '');
      lobby.players.forEach((player) => {
        lines.push(formatPlayerLine(player));
      });
      lines.push('', `Status: ${statusLabel}`, '');
      lines.push('━━━━━━━━━━━━━━', '');
    });

    await interaction.reply({
      content: lines.join('\n'),
      ephemeral: true,
    });
  },
};
