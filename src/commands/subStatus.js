const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const manualSubGrantService = require('../services/manualSubGrantService');

function toDiscordTimestamp(ms) {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

function formatExpiresAt(expiresAtMs) {
  if (expiresAtMs === null || expiresAtMs === undefined) {
    return 'sem vencimento';
  }

  return toDiscordTimestamp(expiresAtMs);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sub-status')
    .setDescription('Mostra o estado da concessão manual de benefício SUB de um usuário.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Usuário para consultar status da concessão manual.')
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

    try {
      const status = manualSubGrantService.getStatus(targetUser.id);

      const lines = [];
      lines.push(`Usuário: <@${targetUser.id}>`);

      if (status.active) {
        lines.push('Concessão manual: ativa');
        lines.push(`Motivo: ${status.active.reason}`);
        lines.push(`Concedida por: <@${status.active.grantedByDiscordId}>`);
        lines.push(`Concedida em: ${toDiscordTimestamp(status.active.grantedAtMs)}`);
        lines.push(`Vencimento: ${formatExpiresAt(status.active.expiresAtMs)}`);
      } else if (status.latestGrant) {
        lines.push('Concessão manual: inativa');
        lines.push(`Último motivo: ${status.latestGrant.reason}`);
        lines.push(`Última concessão por: <@${status.latestGrant.grantedByDiscordId}>`);
        lines.push(`Última concessão em: ${toDiscordTimestamp(status.latestGrant.grantedAtMs)}`);
        lines.push(`Último vencimento: ${formatExpiresAt(status.latestGrant.expiresAtMs)}`);
      } else {
        lines.push('Concessão manual: inativa');
        lines.push('Nenhum histórico de concessão manual encontrado.');
      }

      if (status.latestRevocation) {
        lines.push(`Última revogação por: <@${status.latestRevocation.revokedByDiscordId}>`);
        lines.push(`Última revogação em: ${toDiscordTimestamp(status.latestRevocation.revokedAtMs)}`);
        lines.push(`Motivo da revogação: ${status.latestRevocation.revokeReason}`);
      }

      lines.push('Kick: ainda não sincronizada');
      lines.push('Cargo: ainda não sincronizado nesta etapa');

      await interaction.reply({
        content: lines.join('\n'),
        ephemeral: true,
      });
    } catch (error) {
      await interaction.reply({
        content: `Não foi possível consultar o status: ${error.message}`,
        ephemeral: true,
      });
    }
  },
};
