const queueService = require('../services/queueService');
const queueMessageService = require('../services/queueMessageService');

module.exports = {
  customId: 'leave_queue',
  async execute(interaction) {
    const discordId = interaction.user.id;

    const result = queueService.removeFromQueue(discordId);

    if (result.success) {
      if (result.type === 'waiting') {
        await interaction.reply({
          content: '❌ Você saiu da fila com sucesso.',
          ephemeral: true,
        });
      } else if (result.type === 'forming') {
        await interaction.reply({
          content: '❌ Você saiu do lobby em formação com sucesso.',
          ephemeral: true,
        });
      }

      queueMessageService.updatePanel(interaction.client).catch((error) => {
        console.error('Erro ao atualizar painel após sair da fila:', error);
      });
      return;
    }

    if (result.reason === 'locked') {
      await interaction.reply({
        content: 'Você já está em um lobby e ele não pode mais ser alterado.',
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
