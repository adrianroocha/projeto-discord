const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const schedulerService = require('../services/schedulerService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scheduler-close')
    .setDescription('Fecha a fila imediatamente sem limpar os dados do ciclo atual.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    await schedulerService.closeQueue(interaction.client, { manual: true });
    await interaction.editReply('🔒 Fila fechada manualmente.');
  },
};
