const { MessageFlags } = require('discord.js');
const config = require('../config');
const kickLinkStartService = require('../services/kickLinkStartService');

module.exports = {
  customId: 'kick-link-start',

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este botão só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (config.guildId && interaction.guildId !== config.guildId) {
      await interaction.reply({
        content: 'Este botão só está disponível no servidor configurado para esta integração.',
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
