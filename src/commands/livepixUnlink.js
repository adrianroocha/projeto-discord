const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const livepixAccountsRepository = require('../database/livepixAccountsRepository');
const confirmationService = require('../services/accountUnlinkConfirmationService');

function buildRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`livepix-unlink-confirm:${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Confirmar desvinculação'),
    new ButtonBuilder()
      .setCustomId(`livepix-unlink-cancel:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancelar'),
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('livepix-unlink')
    .setDescription('Inicia a desvinculação administrativa de uma conta LivePix vinculada.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Usuário do Discord cuja conta LivePix será desvinculada.')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Motivo da desvinculação administrativa.')
        .setRequired(true),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: 'Você precisa da permissão de Administrator para usar este comando.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('motivo', true).trim();
    if (!reason) {
      await interaction.reply({
        content: 'O motivo da desvinculação é obrigatório.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const link = livepixAccountsRepository.findByDiscordId(targetUser.id);
    if (!link) {
      await interaction.reply({
        content: `Não há conta LivePix vinculada para <@${targetUser.id}> no momento.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    confirmationService.cleanupExpired();
    const confirmation = confirmationService.create(interaction.user.id, {
      targetDiscordId: targetUser.id,
      reason,
    });

    await interaction.reply({
      content: [
        `Você está prestes a desvincular a conta LivePix ${link.livepix_account_id} de <@${targetUser.id}>.`,
        `Motivo: ${reason}`,
        'Ao confirmar, apenas o vínculo em livepix_accounts será removido e auditado.',
        'Contas, vínculos e dados da Kick não serão alterados.',
        'O usuário poderá vincular novamente pelo painel LivePix.',
        `Esta confirmação expira em <t:${Math.floor(confirmation.expiresAtMs / 1000)}:R>.`,
      ].join('\n'),
      components: [buildRow(confirmation.token)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
