const queueService = require('../services/queueService');
const queueMessageService = require('../services/queueMessageService');
const schedulerService = require('../services/schedulerService');

module.exports = {
  customId: 'leave_queue',
  async execute(interaction) {
    const discordId = interaction.user.id;
    try {
      const result = queueService.removeFromQueue(discordId);
      if (result && result.success) {
        await interaction.reply({ content: '❌ Você saiu da fila e das suas lobbies atuais.', ephemeral: true });
        await queueMessageService.updatePanel(interaction.client, { isQueueOpen: schedulerService.isQueueOpen() }).catch((error) => {
          console.error('Erro ao atualizar painel após sair da fila:', error);
        });
        return;
      }

      if (result && result.reason === 'cooldown') {
        const remainingSeconds = result.remainingSeconds;
        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        const parts = [];
        if (minutes > 0) {
          parts.push(`${minutes} minuto${minutes === 1 ? '' : 's'}`);
        }
        if (seconds > 0) {
          parts.push(`${seconds} segundo${seconds === 1 ? '' : 's'}`);
        }
        const formatted = parts.join(' e ') || '0 segundos';
        await interaction.reply({
          content: `⏳ Você poderá sair da fila em ${formatted}.`,
          ephemeral: true,
        });
        return;
      }

      if (result && result.reason === 'not_found') {
        await interaction.reply({ content: 'Você não está na fila.', ephemeral: true });
        return;
      }

      // fallback
      await interaction.reply({ content: 'Você não está na fila.', ephemeral: true });
    } catch (error) {
      console.error('Erro ao processar leaveQueue:', error);
      throw error;
    }
  },
};
