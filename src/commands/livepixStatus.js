const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const adminCommandAuditService = require('../services/adminCommandAuditService');
const operationalAuthorizationService = require('../services/operationalAuthorizationService');
const livepixAccountsRepository = require('../database/livepixAccountsRepository');

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

  return 'Você só pode consultar o vínculo de outro membro com autorização operacional.';
}

function sanitizeLivePixAccountId(accountId) {
  return String(accountId)
    .replace(/[\r\n\t]/g, '')
    .replace(/[<>@`\\]/g, '')
    .slice(0, 100);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('livepix-status')
    .setDescription('Mostra o estado do vínculo da sua conta LivePix.')
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Usuário para consultar vínculo LivePix (opcional).')
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

    if (!isOwnQuery) {
      try {
        auditContext = await adminCommandAuditService.beginRequired(interaction, {
          commandName: 'livepix-status',
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

      if (!(await fetchGuildMember(interaction.guild, requestedUser.id))) {
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
      const link = livepixAccountsRepository.findByDiscordId(requestedUser.id);
      const lines = [
        `Usuário consultado: <@${requestedUser.id}>`,
        `Conta LivePix vinculada: ${link ? 'sim' : 'não'}`,
      ];
      if (link) {
        lines.push(`ID da conta LivePix: ${sanitizeLivePixAccountId(link.livepix_account_id)}`);
      }

      if (auditContext) {
        await adminCommandAuditService.finishSuccess(auditContext, {
          nextState: {
            targetDiscordId: requestedUser.id,
            queryScope: 'third_party',
          },
          client: interaction.client,
        });
      }

      await interaction.reply({
        content: lines.join('\n'),
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      if (auditContext) {
        await adminCommandAuditService.finishFailed(auditContext, {
          errorCode: 'LIVEPIX_STATUS_READ_FAILED',
          nextState: {
            failed: true,
            reason: 'livepix_status_read_failed',
            targetDiscordId: requestedUser.id,
            queryScope: 'third_party',
          },
          client: interaction.client,
        });
      }

      await interaction.reply({
        content: 'Não foi possível consultar o status no momento. Código: LIVEPIX_STATUS_READ_FAILED.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
