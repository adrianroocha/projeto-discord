const {
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');
const config = require('../config');
const kickAccountsRepository = require('../database/kickAccountsRepository');
const adminCommandAuditService = require('../services/adminCommandAuditService');
const operationalAuthorizationService = require('../services/operationalAuthorizationService');
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
    return 'indisponível';
  }

  if (source.active) {
    return 'ativa';
  }

  if (source.observed) {
    return 'inativa';
  }

  return 'ainda não observada por webhook';
}

function formatOptionalTimestamp(ms) {
  if (ms === null || ms === undefined) {
    return 'indisponível';
  }

  return toDiscordFullTimestamp(ms);
}

async function fetchGuildMember(guild, discordId) {
  if (!guild || !guild.members || typeof guild.members.fetch !== 'function') {
    return null;
  }

  try {
    return await guild.members.fetch(discordId);
  } catch {
    return null;
  }
}

function getSafeInteractionUser(interaction) {
  return interaction.options?.getUser?.('usuario', false) || interaction.user;
}

function buildCrossQueryDeniedReplyContent(code) {
  if (code === operationalAuthorizationService.codes.MEMBER_UNAVAILABLE) {
    return 'Não foi possível validar sua autorização operacional neste servidor. Consulta recusada.';
  }

  return 'Você só pode consultar o status de outro membro com autorização operacional.';
}

async function buildSubRoleDiagnostics(interaction, discordId, prefetchedMember) {
  const member = prefetchedMember || (await fetchGuildMember(interaction.guild, discordId));
  if (!member) {
    return {
      subRoleStatus: 'membro indisponível',
      manageabilityStatus: 'indisponível',
    };
  }

  const subscriberRoleId = typeof config.subscriberRoleId === 'string' ? config.subscriberRoleId.trim() : '';
  const hasSubRole =
    Boolean(subscriberRoleId) &&
    Boolean(member.roles?.cache?.has && member.roles.cache.has(subscriberRoleId));

  return {
    subRoleStatus: subscriberRoleId ? (hasSubRole ? 'presente' : 'ausente') : 'indisponível',
    manageabilityStatus: member.manageable ? 'gerenciável' : 'não gerenciável',
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick-status')
    .setDescription('Mostra o estado do vínculo da sua conta da Kick.')
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Usuário para consultar status Kick (opcional).')
        .setRequired(false),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const requestedUser = getSafeInteractionUser(interaction);
    const isOwnQuery = requestedUser.id === interaction.user.id;
    let auditContext = null;
    let targetMember = null;

    if (!isOwnQuery) {
      try {
        auditContext = await adminCommandAuditService.beginRequired(interaction, {
          commandName: 'kick-status',
          parameters: {
            targetDiscordId: requestedUser.id,
            queryScope: 'third_party',
          },
        });
      } catch {
        await interaction.reply({
          content: 'Não foi possível registrar a auditoria obrigatória desta consulta. Operação recusada.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const authorization = await operationalAuthorizationService.authorize(interaction);
      if (!authorization.allowed) {
        await adminCommandAuditService.finishDenied(auditContext, {
          errorCode: authorization.code,
          nextState: {
            denied: true,
            reason: authorization.reason,
            targetDiscordId: requestedUser.id,
            queryScope: 'third_party',
          },
          client: interaction.client,
        });

        await interaction.reply({
          content: buildCrossQueryDeniedReplyContent(authorization.code),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      targetMember = await fetchGuildMember(interaction.guild, requestedUser.id);
      if (!targetMember) {
        await adminCommandAuditService.finishFailed(auditContext, {
          errorCode: 'TARGET_MEMBER_UNAVAILABLE',
          nextState: {
            failed: true,
            reason: 'target_member_unavailable',
            targetDiscordId: requestedUser.id,
            queryScope: 'third_party',
          },
          client: interaction.client,
        });

        await interaction.reply({
          content: 'O usuário informado não está disponível neste servidor.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    try {
      const targetDiscordId = requestedUser.id;
      const eligibility = subscriberEligibilityService.getEligibility(targetDiscordId);
      const kickSource = eligibility.sources.kick;
      const manualSource = eligibility.sources.manual;
      const linkedAccount = kickSource.linked
        ? kickAccountsRepository.findByDiscordId(targetDiscordId)
        : null;

      const activeSources = [];
      if (kickSource.active) {
        activeSources.push('- Kick');
      }
      if (manualSource.active) {
        activeSources.push('- Concessão manual');
      }

      const diagnostics = await buildSubRoleDiagnostics(
        interaction,
        targetDiscordId,
        targetMember,
      );

      if (auditContext) {
        await adminCommandAuditService.finishSuccess(auditContext, {
          nextState: {
            targetDiscordId,
            queryScope: 'third_party',
          },
          client: interaction.client,
        });
      }

      await interaction.reply({
        content: [
          `Usuário consultado: <@${targetDiscordId}>`,
          `Conta Kick vinculada: ${kickSource.linked ? 'sim' : 'não'}`,
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
          `Cargo SUB: ${diagnostics.subRoleStatus}`,
          `Membro gerenciável pelo bot: ${diagnostics.manageabilityStatus}`,
          'Cargo SUB: sincronizado por gatilhos automáticos e reconciliação periódica.',
          'Prioridade da fila: definida por snapshot na primeira entrada do usuário em cada ciclo.',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      if (auditContext) {
        await adminCommandAuditService.finishFailed(auditContext, {
          errorCode: 'KICK_STATUS_READ_FAILED',
          nextState: {
            failed: true,
            reason: 'kick_status_read_failed',
            targetDiscordId: requestedUser.id,
            queryScope: 'third_party',
          },
          client: interaction.client,
        });
      }

      await interaction.reply({
        content: 'Não foi possível consultar o status no momento. Código: KICK_STATUS_READ_FAILED.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
