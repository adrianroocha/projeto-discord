const queueService = require('../services/queueService');
const queueMessageService = require('../services/queueMessageService');

module.exports = {
  customId: 'join_queue',
  async execute(interaction) {
    const discordId = interaction.user.id;
    const username = `${interaction.user.username}#${interaction.user.discriminator}`;
    const displayName = interaction.member?.displayName || interaction.user.username;

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
      displayName,
      isSubscriber: 0,
    });

    if (added) {
      await interaction.reply({
        content: '✅ Você entrou na fila com sucesso.',
        ephemeral: true,
      });

      queueMessageService.updatePanel(interaction.client).catch((error) => {
        console.error('Erro ao atualizar painel após entrar na fila:', error);
      });
      return;
    }

    await interaction.reply({
      content: 'Não foi possível entrar na fila. Tente novamente mais tarde.',
      ephemeral: true,
    });
  },
};
