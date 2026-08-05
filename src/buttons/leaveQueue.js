const queueService = require('../services/queueService');

module.exports = {
  customId: 'leave_queue',
  async execute(interaction) {
    const discordId = interaction.user.id;

    const removed = queueService.removeFromQueue(discordId);

    if (removed) {
      await interaction.reply({
        content: '❌ Você saiu da fila com sucesso.',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: 'Você não está na fila.',
      ephemeral: true,
    });
  },
};
