const { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
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
    .setDescription('Inicia a desvinculação administrativa de uma conta Kick vinculada.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Usuário do Discord cuja conta Kick será desvinculada.')
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

    const link = kickAccountsRepository.findByDiscordId(targetUser.id);
    if (!link) {
      await interaction.reply({
        content: `Não há conta Kick vinculada para <@${targetUser.id}> no momento.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    confirmationService.cleanupExpired();
    const confirmation = confirmationService.create(interaction.user.id, {
      targetDiscordId: targetUser.id,
      kickUsername: link.kick_username,
      kickUserId: link.kick_user_id,
      reason,
    });

    await interaction.reply({
      content: [
        `Você está prestes a desvincular a conta Kick ${link.kick_username} de <@${targetUser.id}>.`,
        `Motivo: ${reason}`,
        'Ao confirmar, apenas o vínculo em kick_accounts será removido e auditado.',
        'Concessões manuais e histórico de subscriptions Kick serão preservados.',
        'O usuário poderá vincular novamente pelo painel ou por /kick-link.',
        `Esta confirmação expira em <t:${Math.floor(confirmation.expiresAtMs / 1000)}:R>.`,
      ].join('\n'),
      components: [buildRow(confirmation.token)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
