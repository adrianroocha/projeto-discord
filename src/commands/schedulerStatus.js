const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const schedulerService = require('../services/schedulerService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scheduler-status')
    .setDescription('Exibe o estado atual do scheduler da fila.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const status = schedulerService.getStatus();
    const lines = [
      `Modo: ${status.mode}`,
      `Estado: ${status.state}`,
      `Origem do estado: ${status.origin}`,
      `Timezone efetivo: ${status.timezone}`,
      `Abertura configurada: ${status.configuredOpenTime}`,
      `Fechamento configurado: ${status.configuredCloseTime}`,
      `Próxima abertura: ${status.nextOpenAt}`,
      `Próximo fechamento: ${status.nextCloseAt}`,
    ];

    if (status.currentCycleKey) {
      lines.push(`Chave do ciclo atual: ${status.currentCycleKey}`);
    }

    if (status.testIntervalMinutes) {
      lines.push(`Intervalo de teste: ${status.testIntervalMinutes} minutos`);
    }
    await interaction.editReply(lines.join('\n'));
  },
};
