const queueService = require('../services/queueService');

module.exports = {
  customId: 'join_queue',
  async execute(interaction) {
    const discordId = interaction.user.id;
    const username = `${interaction.user.username}#${interaction.user.discriminator}`;

    if (queueService.isUserInQueue(discordId)) {
      await interaction.reply({
        content: 'Você já está na fila.',
        ephemeral: true,
      });
      return;
    }

    const added = queueService.addToQueue({
      discordId,
      username,
      isSubscriber: 0,
    });

    if (added) {
      await interaction.reply({
        content: '✅ Você entrou na fila com sucesso.',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: 'Não foi possível entrar na fila. Tente novamente mais tarde.',
      ephemeral: true,
    });
  },
};
