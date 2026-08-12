const {
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');
const adminCommandAuditService = require('../services/adminCommandAuditService');
const operationalAuthorizationService = require('../services/operationalAuthorizationService');
const kickStatusDiagnosticsService = require('../services/kickStatusDiagnosticsService');

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
      const status = await kickStatusDiagnosticsService.readLocalKickStatus({
        discordId: targetDiscordId,
        guild: interaction.guild,
        prefetchedMember: targetMember,
      });

      const content = kickStatusDiagnosticsService.formatKickStatusContent(status, {
        includeUserLine: true,
        includeKickId: true,
      });

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
        content,
        allowedMentions: { parse: [] },
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
