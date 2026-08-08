const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const schedulerService = require('../services/schedulerService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scheduler-open')
    .setDescription('Abre a fila imediatamente e reinicia o ciclo atual.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await schedulerService.openQueue(interaction.client, { manual: true });
    await interaction.editReply('✅ Fila aberta manualmente.');
  },
};
