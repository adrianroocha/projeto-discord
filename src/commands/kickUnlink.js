const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const kickAccountsRepository = require('../database/kickAccountsRepository');
const confirmationService = require('../services/kickUnlinkConfirmationService');

function buildRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`kick-unlink-confirm:${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Confirmar desvinculação'),
    new ButtonBuilder()
      .setCustomId(`kick-unlink-cancel:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancelar'),
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick-unlink')
    .setDescription('Inicia o processo seguro de desvinculação da conta Kick.'),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        ephemeral: true,
      });
      return;
    }

    const link = kickAccountsRepository.findByDiscordId(interaction.user.id);
    if (!link) {
      await interaction.reply({
        content: 'Não há conta Kick vinculada ao seu usuário no momento.',
        ephemeral: true,
      });
      return;
    }

    confirmationService.cleanupExpired();
    const confirmation = confirmationService.create(interaction.user.id, {
      kickUsername: link.kick_username,
      kickUserId: link.kick_user_id,
    });

    await interaction.reply({
      content: [
        `Você está prestes a desvincular a conta Kick ${link.kick_username}.`,
        'Ao confirmar, os dados de vínculo Discord ↔ Kick serão removidos.',
        'Você poderá vincular novamente depois usando /kick-link.',
        'A integração de cargo/subscriber ainda não está ativa nesta etapa.',
        `Esta confirmação expira em <t:${Math.floor(confirmation.expiresAtMs / 1000)}:R>.`,
      ].join('\n'),
      components: [buildRow(confirmation.token)],
      ephemeral: true,
    });
  },
};
