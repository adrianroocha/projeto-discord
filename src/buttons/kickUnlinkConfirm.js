const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const kickAccountsRepository = require('../database/kickAccountsRepository');
const confirmationService = require('../services/kickUnlinkConfirmationService');

const PREFIX = 'kick-unlink-confirm:';

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
        ephemeral: true,
      });
      return;
    }

    const consumed = confirmationService.consume(token, interaction.user.id);
    if (!consumed.ok) {
      await interaction.reply({
        content: 'Esta confirmação é inválida, expirou ou já foi utilizada.',
        ephemeral: true,
      });
      return;
    }

    const existingLink = kickAccountsRepository.findByDiscordId(interaction.user.id);
    if (!existingLink) {
      await interaction.update({
        content: 'Nenhum vínculo ativo foi encontrado. A conta já estava desvinculada.',
        components: [buildDisabledRow(token)],
      });
      return;
    }

    kickAccountsRepository.deleteByDiscordId(interaction.user.id);

    await interaction.update({
      content: 'Desvinculação concluída com sucesso. Você pode vincular novamente usando /kick-link.',
      components: [buildDisabledRow(token)],
    });
  },
};
