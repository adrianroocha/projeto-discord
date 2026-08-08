const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const kickAccountsRepository = require('../database/kickAccountsRepository');
const subscriberEligibilityService = require('../services/subscriberEligibilityService');

function toDiscordFullTimestamp(linkedAtMs) {
  const unixSeconds = Math.floor(Number(linkedAtMs) / 1000);
  if (!Number.isFinite(unixSeconds)) {
    return 'Data indisponível';
  }
  return `<t:${unixSeconds}:F>`;
}

function mapKickSubscriptionType(type) {
  if (type === 'direct') {
    return 'direta';
  }

  if (type === 'gifted') {
    return 'presenteada';
  }

  return 'indisponível';
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

function formatOptionalTimestamp(ms) {
  if (ms === null || ms === undefined) {
    return 'indisponível';
  }

  return toDiscordFullTimestamp(ms);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick-status')
    .setDescription('Mostra o estado do vínculo da sua conta da Kick.'),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const eligibility = subscriberEligibilityService.getEligibility(interaction.user.id);
    const kickSource = eligibility.sources.kick;
    const manualSource = eligibility.sources.manual;
    const linkedAccount = kickSource.linked
      ? kickAccountsRepository.findByDiscordId(interaction.user.id)
      : null;

    const activeSources = [];
    if (kickSource.active) {
      activeSources.push('- Kick');
    }
    if (manualSource.active) {
      activeSources.push('- Concessão manual');
    }

    await interaction.reply({
      content: [
        `Conta Kick: ${kickSource.linked ? kickSource.kickUsername : 'não vinculada'}`,
        `Kick ID: ${kickSource.linked ? kickSource.kickUserId : 'indisponível'}`,
        `Vinculada em: ${formatOptionalTimestamp(linkedAccount?.linked_at_ms ?? null)}`,
        `Assinatura Kick: ${mapKickStatus(kickSource)}`,
        `Tipo Kick: ${kickSource.observed ? mapKickSubscriptionType(kickSource.subscriptionType) : 'indisponível'}`,
        `Início Kick: ${formatOptionalTimestamp(kickSource.startedAtMs)}`,
        `Vencimento Kick: ${formatOptionalTimestamp(kickSource.expiresAtMs)}`,
        `Concessão manual: ${manualSource.active ? 'ativa' : 'inativa'}`,
        `Motivo manual: ${manualSource.active ? manualSource.reason : 'indisponível'}`,
        `Vencimento manual: ${manualSource.active ? formatOptionalTimestamp(manualSource.expiresAtMs) : 'indisponível'}`,
        `Elegibilidade: ${eligibility.eligible ? 'ativa' : 'inativa'}`,
        'Fontes ativas:',
        activeSources.length > 0 ? activeSources.join('\n') : '- nenhuma',
        'Cargo SUB: sincronizado por gatilhos automáticos e reconciliação periódica.',
        'Prioridade da fila: definida por snapshot na primeira entrada do usuário em cada ciclo.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  },
};
