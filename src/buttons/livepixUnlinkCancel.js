const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const confirmationService = require('../services/accountUnlinkConfirmationService');

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
    const validation = confirmationService.validate(token, interaction.user.id);
    if (!validation.ok) {
      await interaction.reply({
        content:
          validation.reason === 'forbidden'
            ? 'Esta confirmação pertence a outro usuário.'
            : 'Esta confirmação é inválida, expirou ou já foi utilizada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    confirmationService.invalidate(token);
    await interaction.update({
      content: 'Desvinculação LivePix cancelada.',
      components: [buildDisabledRow(token)],
    });
  },
};
