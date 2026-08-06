const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const manualSubGrantService = require('../services/manualSubGrantService');

function toDiscordTimestamp(ms) {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sub-revoke')
    .setDescription('Revoga concessão manual ativa de benefício SUB.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Usuário alvo da revogação manual.')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Motivo da revogação.')
        .setRequired(true),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        ephemeral: true,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: 'Você precisa da permissão de Administrator para usar este comando.',
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('motivo', true);

    try {
      const result = manualSubGrantService.revokeGrant({
        discordId: targetUser.id,
        revokedByDiscordId: interaction.user.id,
        reason,
      });

      if (!result.revoked) {
        await interaction.reply({
          content: 'Não há concessão manual ativa para este usuário no momento.',
          ephemeral: true,
        });
        return;
      }

      const grant = result.grant;
      await interaction.reply({
        content: [
          'Concessão manual revogada.',
          `Usuário: <@${grant.discordId}>`,
          `Revogada por: <@${grant.revokedByDiscordId}>`,
          `Revogada em: ${toDiscordTimestamp(grant.revokedAtMs)}`,
          `Motivo: ${grant.revokeReason}`,
          'A elegibilidade final dependerá também da assinatura Kick quando a sincronização estiver ativa.',
        ].join('\n'),
        ephemeral: true,
      });
    } catch (error) {
      await interaction.reply({
        content: `Não foi possível revogar a concessão manual: ${error.message}`,
        ephemeral: true,
      });
    }
  },
};
