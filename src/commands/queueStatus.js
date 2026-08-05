const { SlashCommandBuilder } = require('discord.js');
const queueService = require('../services/queueService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fila-status')
    .setDescription('Mostra a fila atual de jogadores.'),
  async execute(interaction) {
    const queueEntries = queueService.getQueue();

    if (!queueEntries.length) {
      await interaction.reply({
        content: '🎮 Fila atual\n\nA fila está vazia no momento.',
        ephemeral: true,
      });
      return;
    }

    const lines = queueEntries.map((entry, index) => {
      const position = index + 1;
      const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `#${position}`;
      const subscriberTag = entry.is_subscriber ? ' (SUB)' : '';
      return `${medal} ${position} - ${entry.username}${subscriberTag}`;
    });

    await interaction.reply({
      content: `🎮 Fila atual\n\n${lines.join('\n')}`,
      ephemeral: true,
    });
  },
};
