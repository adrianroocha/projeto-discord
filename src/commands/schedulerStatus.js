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
      `Próxima abertura: ${status.nextOpenAt}`,
      `Próximo fechamento: ${status.nextCloseAt}`,
    ];
    if (status.testIntervalMinutes) {
      lines.push(`Intervalo de teste: ${status.testIntervalMinutes} minutos`);
    }
    await interaction.editReply(lines.join('\n'));
  },
};
