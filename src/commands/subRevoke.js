const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const manualSubGrantService = require('../services/manualSubGrantService');
const subscriberRoleAutoSyncService = require('../services/subscriberRoleAutoSyncService');

function toDiscordTimestamp(ms) {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

function mapEligibilityLabel(value) {
  if (value === true) {
    return 'ativa';
  }

  if (value === false) {
    return 'inativa';
  }

  return 'indisponível';
}

function mapRoleStateLabel(roleState) {
  if (roleState === 'added') {
    return 'adicionado';
  }

  if (roleState === 'removed') {
    return 'removido';
  }

  if (roleState === 'kept') {
    return 'mantido';
  }

  return 'sincronização pendente';
}

function formatSources(sources) {
  const activeSources = [];
  if (sources?.kick) {
    activeSources.push('- Kick');
  }
  if (sources?.manual) {
    activeSources.push('- Concessão manual');
  }
  return activeSources.length > 0 ? activeSources.join('\n') : '- nenhuma';
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
      const syncResult = await subscriberRoleAutoSyncService.syncAfterEligibilityChange({
        discordId: grant.discordId,
        triggerType: 'manual_revoke',
        reason: `Revogação manual: ${grant.revokeReason}`,
        triggeredByDiscordId: interaction.user.id,
        client: interaction.client,
      });

      const lines = [
        'Concessão manual revogada.',
        `Usuário: <@${grant.discordId}>`,
        `Revogada por: <@${grant.revokedByDiscordId}>`,
        `Revogada em: ${toDiscordTimestamp(grant.revokedAtMs)}`,
        `Motivo: ${grant.revokeReason}`,
        `Elegibilidade final: ${mapEligibilityLabel(syncResult.eligibility)}`,
        'Fontes ativas:',
        formatSources(syncResult.sources),
        `Estado do cargo SUB: ${mapRoleStateLabel(syncResult.roleState)}`,
      ];

      if (syncResult.status === 'warning') {
        lines.push(
          'A revogação foi salva, mas a sincronização automática do cargo ficou pendente. Use /sub-sync para reconciliar.',
        );
      }

      await interaction.reply({
        content: lines.join('\n'),
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
