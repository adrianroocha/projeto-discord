const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const livepixAccountsRepository = require('../database/livepixAccountsRepository');
const confirmationService = require('../services/livepixUnlinkConfirmationService');

const PREFIX = 'livepix-unlink-confirm:';

function buildDisabledRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Confirmar desvinculação')
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`livepix-unlink-cancel:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancelar')
      .setDisabled(true),
  );
}

module.exports = {
  customIdPrefix: PREFIX,

  async execute(interaction) {
    const token = (interaction.customId || '').slice(PREFIX.length);
    const result = confirmationService.consume(token, interaction.user.id);
    if (!result.ok) {
      await interaction.reply({
        content:
          result.reason === 'forbidden'
            ? 'Esta confirmação pertence a outro usuário.'
            : 'Esta confirmação é inválida, expirou ou já foi utilizada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const removed = livepixAccountsRepository.unlinkByDiscordId(interaction.user.id);
      await interaction.update({
        content: removed
          ? 'Sua conta LivePix foi desvinculada. O vínculo Kick não foi alterado.'
          : 'Nenhum vínculo LivePix ativo foi encontrado.',
        components: [buildDisabledRow(token)],
      });
    } catch (error) {
      console.error(`Falha ao desvincular conta LivePix. code=${error?.code || error?.name || 'unknown_error'}`);
      await interaction.update({
        content: 'Não foi possível concluir a desvinculação LivePix.',
        components: [buildDisabledRow(token)],
      });
    }
  },
};
