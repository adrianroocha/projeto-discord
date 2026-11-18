const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const confirmationService = require('../services/livepixUnlinkConfirmationService');

const PREFIX = 'livepix-unlink-cancel:';

function buildDisabledRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`livepix-unlink-confirm:${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Confirmar desvinculação')
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancelar')
      .setDisabled(true),
  );
}

module.exports = {
  customIdPrefix: PREFIX,

  async execute(interaction) {
    const token = (interaction.customId || '').slice(PREFIX.length);
    if (!confirmationService.invalidate(token, interaction.user.id)) {
      await interaction.reply({
        content: 'Esta confirmação é inválida, expirou ou já foi utilizada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.update({
      content: 'Desvinculação LivePix cancelada.',
      components: [buildDisabledRow(token)],
    });
  },
};
