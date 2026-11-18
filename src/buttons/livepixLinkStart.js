const { MessageFlags } = require('discord.js');
const config = require('../config');
const livepixLinkStartService = require('../services/livepixLinkStartService');

module.exports = {
  customId: 'livepix-link-start',

  async execute(interaction) {
    if (!interaction.inGuild() || (config.guildId && interaction.guildId !== config.guildId)) {
      await interaction.reply({
        content: 'Este botão só está disponível no servidor configurado para esta integração.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      const payload = livepixLinkStartService.createStartPayload(interaction.user.id);
      await interaction.reply({
        content: payload.content,
        components: payload.components,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({
        content: livepixLinkStartService.mapError(error),
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
