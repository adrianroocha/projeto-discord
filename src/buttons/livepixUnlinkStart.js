const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const config = require('../config');
const livepixAccountsRepository = require('../database/livepixAccountsRepository');
const confirmationService = require('../services/livepixUnlinkConfirmationService');

module.exports = {
  customId: 'livepix-unlink-start',

  async execute(interaction) {
    if (!interaction.inGuild() || (config.guildId && interaction.guildId !== config.guildId)) {
      await interaction.reply({
        content: 'Este botão só está disponível no servidor configurado para esta integração.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!livepixAccountsRepository.findByDiscordId(interaction.user.id)) {
      await interaction.reply({
        content: 'Você não possui uma conta LivePix vinculada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const { token } = confirmationService.create(interaction.user.id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`livepix-unlink-confirm:${token}`)
        .setStyle(ButtonStyle.Danger)
        .setLabel('Confirmar desvinculação'),
      new ButtonBuilder()
        .setCustomId(`livepix-unlink-cancel:${token}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Cancelar'),
    );
    await interaction.reply({
      content: 'Confirme a desvinculação da sua conta LivePix. O vínculo Kick não será alterado.',
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  },
};
