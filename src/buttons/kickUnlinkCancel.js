const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const confirmationService = require('../services/kickUnlinkConfirmationService');

const PREFIX = 'kick-unlink-cancel:';

function buildDisabledRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`kick-unlink-confirm:${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Confirmar desvinculação')
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`kick-unlink-cancel:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancelar')
      .setDisabled(true),
  );
}

function getToken(customId) {
  return customId.slice(PREFIX.length);
}

module.exports = {
  customIdPrefix: PREFIX,

  async execute(interaction) {
    const token = getToken(interaction.customId || '');
    const validation = confirmationService.validate(token, interaction.user.id);

    if (!validation.ok) {
      const reasonMessage =
        validation.reason === 'forbidden'
          ? 'Esta confirmação pertence a outro usuário.'
          : 'Esta confirmação é inválida, expirou ou já foi utilizada.';

      await interaction.reply({
        content: reasonMessage,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    confirmationService.invalidate(token);

    await interaction.update({
      content: 'Desvinculação cancelada.',
      components: [buildDisabledRow(token)],
    });
  },
};
