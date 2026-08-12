const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const manualSubGrantService = require('../services/manualSubGrantService');
const subscriberRoleAutoSyncService = require('../services/subscriberRoleAutoSyncService');
const adminCommandAuditService = require('../services/adminCommandAuditService');

const SAFE_CODES = {
  OK: 'OK',
  MISSING_PERMISSION: 'MISSING_PERMISSION',
  MEMBER_UNAVAILABLE: 'MEMBER_UNAVAILABLE',
  INVALID_INPUT: 'INVALID_INPUT',
  MANUAL_GRANT_NOT_FOUND: 'MANUAL_GRANT_NOT_FOUND',
  MANUAL_GRANT_REVOKED: 'MANUAL_GRANT_REVOKED',
  MANUAL_GRANT_NOT_EXTENDABLE: 'MANUAL_GRANT_NOT_EXTENDABLE',
  EXTEND_TRANSACTION_FAILED: 'EXTEND_TRANSACTION_FAILED',
  DUPLICATE_INTERACTION: 'DUPLICATE_INTERACTION',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

function toDiscordTimestamp(ms) {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

function mapRoleStateLabel(roleState) {
  if (roleState === 'added') {
    return 'adicionado';
  }

  if (roleState === 'removed') {
    return 'removido';
  }

  if (roleState === 'kept') {
    return 'já presente';
  }

  return 'sincronização pendente';
}

function buildDeniedReplyContent(code) {
  if (code === SAFE_CODES.MEMBER_UNAVAILABLE) {
    return 'Não foi possível validar sua autorização neste servidor. Operação recusada.';
  }

  return 'Você precisa da permissão de Administrator para usar este comando.';
}

function buildFailureReplyContent(code) {
  switch (code) {
    case SAFE_CODES.INVALID_INPUT:
      return 'Parâmetros inválidos para estender a concessão manual.';
    case SAFE_CODES.MANUAL_GRANT_NOT_FOUND:
      return 'Não existe concessão manual para este usuário. Use /sub-grant para criar uma nova concessão.';
    case SAFE_CODES.MANUAL_GRANT_REVOKED:
      return 'A concessão manual deste usuário foi revogada. Registre uma nova concessão via /sub-grant.';
    case SAFE_CODES.MANUAL_GRANT_NOT_EXTENDABLE:
      return 'A concessão manual atual não precisa ou não pode ser estendida.';
    case SAFE_CODES.DUPLICATE_INTERACTION:
      return 'Esta interação já foi processada anteriormente.';
    case SAFE_CODES.EXTEND_TRANSACTION_FAILED:
      return 'Falha transacional ao estender a concessão manual. Nenhuma alteração foi persistida.';
    default:
      return 'Não foi possível concluir a extensão da concessão manual no momento.';
  }
}

async function authorizeAdministrator(interaction) {
  if ((typeof interaction?.inGuild === 'function' && !interaction.inGuild()) || !interaction?.guild) {
    return {
      allowed: false,
      code: SAFE_CODES.MEMBER_UNAVAILABLE,
      reason: 'guild_unavailable',
    };
  }

  let member = null;
  try {
    member = await interaction.guild.members.fetch(interaction.user?.id);
  } catch {
    member = null;
  }

  if (!member) {
    return {
      allowed: false,
      code: SAFE_CODES.MEMBER_UNAVAILABLE,
      reason: 'member_unavailable',
    };
  }

  if (!member.permissions?.has?.(PermissionFlagsBits.Administrator)) {
    return {
      allowed: false,
      code: SAFE_CODES.MISSING_PERMISSION,
      reason: 'missing_permission',
    };
  }

  return {
    allowed: true,
    code: SAFE_CODES.OK,
    reason: null,
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sub-grant-extend')
    .setDescription('Estende uma concessão manual de benefício SUB já existente.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Usuário que terá a concessão manual estendida.')
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('dias')
        .setDescription(`Quantidade de dias para estender (${manualSubGrantService.constants.MIN_DAYS}-${manualSubGrantService.constants.MAX_DAYS}).`)
        .setRequired(true)
        .setMinValue(manualSubGrantService.constants.MIN_DAYS)
        .setMaxValue(manualSubGrantService.constants.MAX_DAYS),
    )
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Motivo da extensão administrativa.')
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(200),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser = interaction.options.getUser('usuario', true);
    const days = interaction.options.getInteger('dias', true);
    const reason = String(interaction.options.getString('motivo', true) || '').trim();

    const parameters = {
      usuario: targetUser?.id || null,
      dias: days,
      motivo: reason,
    };

    const authorization = await authorizeAdministrator(interaction);
    if (!authorization.allowed) {
      let deniedAudit;
      try {
        deniedAudit = await adminCommandAuditService.beginRequired(interaction, {
          commandName: 'sub-grant-extend',
          parameters,
        });
      } catch (error) {
        const auditCode = adminCommandAuditService.normalizeErrorCode(
          error?.code,
          SAFE_CODES.INTERNAL_ERROR,
        );
        await interaction.reply({
          content:
            auditCode === SAFE_CODES.DUPLICATE_INTERACTION
              ? buildFailureReplyContent(SAFE_CODES.DUPLICATE_INTERACTION)
              : 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await adminCommandAuditService.finishDenied(deniedAudit, {
        errorCode: authorization.code,
        nextState: {
          denied: true,
          reason: authorization.reason,
          targetDiscordId: targetUser?.id || null,
        },
        client: interaction.client,
      });

      await interaction.reply({
        content: buildDeniedReplyContent(authorization.code),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let auditContext;
    try {
      auditContext = await adminCommandAuditService.beginRequired(interaction, {
        commandName: 'sub-grant-extend',
        parameters,
      });
    } catch (error) {
      const auditCode = adminCommandAuditService.normalizeErrorCode(error?.code, SAFE_CODES.INTERNAL_ERROR);
      await interaction.reply({
        content:
          auditCode === SAFE_CODES.DUPLICATE_INTERACTION
            ? buildFailureReplyContent(SAFE_CODES.DUPLICATE_INTERACTION)
            : 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const finishFailed = async (errorCode, nextState = {}) => {
      await adminCommandAuditService.finishFailed(auditContext, {
        errorCode,
        nextState,
        client: interaction.client,
      });
    };

    if (
      !targetUser ||
      targetUser.bot ||
      !Number.isInteger(days) ||
      days < manualSubGrantService.constants.MIN_DAYS ||
      days > manualSubGrantService.constants.MAX_DAYS ||
      !reason ||
      reason.length < 3 ||
      reason.length > 200
    ) {
      await finishFailed(SAFE_CODES.INVALID_INPUT, {
        failed: true,
        reason: 'invalid_input',
      });

      await interaction.reply({
        content: buildFailureReplyContent(SAFE_CODES.INVALID_INPUT),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let extendResult;
    try {
      extendResult = manualSubGrantService.extendGrant({
        discordId: targetUser.id,
        extendedByDiscordId: interaction.user.id,
        reason,
        days,
      });
    } catch {
      await finishFailed(SAFE_CODES.INTERNAL_ERROR, {
        failed: true,
        reason: 'unexpected_exception',
      });

      await interaction.reply({
        content: buildFailureReplyContent(SAFE_CODES.INTERNAL_ERROR),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!extendResult.extended) {
      const safeCodeByReason = {
        not_found: SAFE_CODES.MANUAL_GRANT_NOT_FOUND,
        revoked: SAFE_CODES.MANUAL_GRANT_REVOKED,
        not_extendable: SAFE_CODES.MANUAL_GRANT_NOT_EXTENDABLE,
        extend_transaction_failed: SAFE_CODES.EXTEND_TRANSACTION_FAILED,
      };

      const safeCode = safeCodeByReason[extendResult.reason] || SAFE_CODES.INTERNAL_ERROR;
      await finishFailed(safeCode, {
        failed: true,
        reason: safeCode,
        targetDiscordId: targetUser.id,
      });

      await interaction.reply({
        content: buildFailureReplyContent(safeCode),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const syncResult = await subscriberRoleAutoSyncService.syncAfterEligibilityChange({
      discordId: targetUser.id,
      triggerType: 'manual_grant_extend',
      reason: `Extensão manual: ${reason}`,
      triggeredByDiscordId: interaction.user.id,
      client: interaction.client,
    });

    await adminCommandAuditService.finishSuccess(auditContext, {
      nextState: {
        targetDiscordId: targetUser.id,
        daysAdded: days,
        previousStatus: extendResult.statusBefore,
        previousExpiresAtMs: extendResult.previousExpiresAtMs,
        newExpiresAtMs: extendResult.newExpiresAtMs,
        roleState: syncResult.roleState,
        roleSyncStatus: syncResult.status,
      },
      client: interaction.client,
    });

    const lines = [
      'Concessão manual estendida com sucesso.',
      '',
      `Usuário: <@${targetUser.id}>`,
      `Dias acrescentados: ${days}`,
      `Vencimento anterior: ${toDiscordTimestamp(extendResult.previousExpiresAtMs)}`,
      `Novo vencimento: ${toDiscordTimestamp(extendResult.newExpiresAtMs)}`,
      `Motivo: ${reason}`,
      `Estado anterior: ${extendResult.statusBefore === 'active' ? 'ativa' : 'expirada'}`,
      `Cargo Sub: ${mapRoleStateLabel(syncResult.roleState)}`,
    ];

    if (syncResult.status === 'warning') {
      lines.push('A extensão foi salva, mas a sincronização automática do cargo ficou pendente. Use /sub-sync para reconciliar.');
    }

    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};
