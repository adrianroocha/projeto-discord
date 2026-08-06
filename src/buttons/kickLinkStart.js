const config = require('../config');
const kickLinkStartService = require('../services/kickLinkStartService');

module.exports = {
  customId: 'kick-link-start',

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este botão só pode ser usado dentro de um servidor.',
        ephemeral: true,
      });
      return;
    }

    if (config.guildId && interaction.guildId !== config.guildId) {
      await interaction.reply({
        content: 'Este botão só está disponível no servidor configurado para esta integração.',
        ephemeral: true,
      });
      return;
    }

    try {
      const payload = kickLinkStartService.createStartPayload(interaction.user.id);
      await interaction.reply({
        content: payload.content,
        components: payload.components,
        ephemeral: true,
      });
    } catch (error) {
      await interaction.reply({
        content: kickLinkStartService.mapKickLinkError(error),
        ephemeral: true,
      });
    }
  },
};
