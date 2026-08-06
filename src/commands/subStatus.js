const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const subscriberEligibilityService = require('../services/subscriberEligibilityService');

function toDiscordTimestamp(ms) {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

function formatExpiresAt(expiresAtMs) {
  if (expiresAtMs === null || expiresAtMs === undefined) {
    return 'sem vencimento';
  }

  return toDiscordTimestamp(expiresAtMs);
}

function formatOptionalTimestamp(ms) {
  if (ms === null || ms === undefined) {
    return 'indisponível';
  }
  return toDiscordTimestamp(ms);
}

function mapKickStatus(source) {
  if (!source.linked) {
    return 'não vinculada';
  }

  if (source.active) {
    return 'ativa';
  }

  if (source.observed) {
    return 'expirada';
  }

  return 'ainda não observada por webhook';
}

function mapSubscriptionType(type) {
  if (type === 'direct') {
    return 'direta';
  }

  if (type === 'gifted') {
    return 'presenteada';
  }

  return 'indisponível';
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
      const eligibility = subscriberEligibilityService.getEligibility(targetUser.id);
      const kickSource = eligibility.sources.kick;
      const manualSource = eligibility.sources.manual;

      const activeSources = [];
      if (kickSource.active) {
        activeSources.push('- Kick');
      }
      if (manualSource.active) {
        activeSources.push('- Concessão manual');
      }

      const lines = [];
      lines.push(`Usuário: <@${targetUser.id}>`);

      lines.push(`Conta Kick: ${kickSource.linked ? kickSource.kickUsername : 'não vinculada'}`);
      lines.push(`Kick ID: ${kickSource.linked ? kickSource.kickUserId : 'indisponível'}`);
      lines.push(`Assinatura Kick: ${mapKickStatus(kickSource)}`);
      lines.push(`Tipo Kick: ${kickSource.observed ? mapSubscriptionType(kickSource.subscriptionType) : 'indisponível'}`);
      lines.push(`Vencimento Kick: ${formatOptionalTimestamp(kickSource.expiresAtMs)}`);

      lines.push(`Concessão manual: ${manualSource.active ? 'ativa' : 'inativa'}`);
      if (manualSource.active) {
        lines.push(`Motivo manual: ${manualSource.reason}`);
        lines.push(`Concedida por: <@${manualSource.grantedByDiscordId}>`);
        lines.push(`Concedida em: ${toDiscordTimestamp(manualSource.grantedAtMs)}`);
        lines.push(`Vencimento manual: ${formatExpiresAt(manualSource.expiresAtMs)}`);
      } else {
        lines.push('Motivo manual: indisponível');
        lines.push('Vencimento manual: indisponível');
      }

      lines.push(`Elegibilidade: ${eligibility.eligible ? 'ativa' : 'inativa'}`);
      lines.push('Fontes ativas:');
      lines.push(activeSources.length > 0 ? activeSources.join('\n') : '- nenhuma');
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
