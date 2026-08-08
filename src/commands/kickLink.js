const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const kickLinkStartService = require('../services/kickLinkStartService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick-link')
    .setDescription('Vincula sua conta da Kick ao seu usuário do Discord.'),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const payload = kickLinkStartService.createStartPayload(interaction.user.id);
      await interaction.reply({
        content: payload.content,
        components: payload.components,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({
        content: kickLinkStartService.mapKickLinkError(error),
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
