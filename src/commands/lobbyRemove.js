const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const queueService = require('../services/queueService');
const adminCommandAuditService = require('../services/adminCommandAuditService');
const operationalAuthorizationService = require('../services/operationalAuthorizationService');

const SAFE_CODES = {
  OK: 'OK',
  MISSING_PERMISSION: 'MISSING_PERMISSION',
  MEMBER_UNAVAILABLE: 'MEMBER_UNAVAILABLE',
  INVALID_INPUT: 'INVALID_INPUT',
  LOBBY_PLAYER_NOT_FOUND: 'LOBBY_PLAYER_NOT_FOUND',
  LOBBY_IMMUTABLE: 'LOBBY_IMMUTABLE',
  LOBBY_STATE_CONFLICT: 'LOBBY_STATE_CONFLICT',
  DUPLICATE_INTERACTION: 'DUPLICATE_INTERACTION',
  REMOVE_TRANSACTION_FAILED: 'REMOVE_TRANSACTION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

function getSafeQueueCycleId() {
  try {
    return queueService.getCurrentQueueCycleId();
  } catch {
    return null;
  }
}

function getSafeOperationalState() {
  try {
    return {
      queueLength: queueService.getQueue().length,
      formingLobbies: queueService.getActiveLobbies('forming').length,
    };
  } catch {
    return null;
  }
}

function buildAuthorizationReplyContent(code) {
  if (code === operationalAuthorizationService.codes.MEMBER_UNAVAILABLE) {
    return 'Não foi possível validar sua autorização operacional neste servidor. Operação recusada.';
  }

  return 'Você precisa de autorização operacional para executar este comando.';
}

function buildFailureMessage(code) {
  switch (code) {
    case SAFE_CODES.INVALID_INPUT:
      return 'Parâmetros inválidos para executar a remoção administrativa.';
    case SAFE_CODES.LOBBY_PLAYER_NOT_FOUND:
      return 'O usuário informado não está em uma lobby removível no ciclo atual.';
    case SAFE_CODES.LOBBY_IMMUTABLE:
      return 'Não é permitido remover jogador de lobby em andamento.';
    case SAFE_CODES.LOBBY_STATE_CONFLICT:
      return 'Conflito de estado da lobby detectado. Nenhuma alteração foi aplicada.';
    case SAFE_CODES.DUPLICATE_INTERACTION:
      return 'Esta interação já foi processada anteriormente.';
    case SAFE_CODES.REMOVE_TRANSACTION_FAILED:
      return 'Falha transacional ao aplicar a remoção. Nenhuma alteração foi persistida.';
    case SAFE_CODES.MEMBER_UNAVAILABLE:
      return 'Não foi possível localizar o membro no servidor para esta operação.';
    default:
      return 'Não foi possível concluir a remoção administrativa no momento.';
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lobby-remove')
    .setDescription('Remove administrativamente um jogador ausente de uma lobby em formação.')
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Jogador que será removido da lobby em formação')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Motivo da remoção administrativa')
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(200),
    ),

  async execute(interaction) {
    const queueCycleId = getSafeQueueCycleId();
    const previousState = getSafeOperationalState();

    const targetUser = interaction.options.getUser('usuario');
    const reason = String(interaction.options.getString('motivo') || '').trim();

    const authorization = await operationalAuthorizationService.authorize(interaction);
    if (!authorization.allowed) {
      let deniedAudit;
      try {
        deniedAudit = await adminCommandAuditService.beginRequired(interaction, {
          commandName: 'lobby-remove',
          parameters: {
            usuario: targetUser?.id || null,
            motivo: reason,
          },
          queueCycleId,
          previousState,
        });
      } catch {
        await interaction.reply({
          content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await adminCommandAuditService.finishDenied(deniedAudit, {
        errorCode: authorization.code,
        queueCycleId,
        previousState,
        nextState: {
          denied: true,
          reason: authorization.reason,
        },
        client: interaction.client,
      });

      await interaction.reply({
        content: buildAuthorizationReplyContent(authorization.code),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let auditContext;
    try {
      auditContext = await adminCommandAuditService.beginRequired(interaction, {
        commandName: 'lobby-remove',
        parameters: {
          usuario: targetUser?.id || null,
          motivo: reason,
        },
        queueCycleId,
        previousState,
      });
    } catch (error) {
      const auditCode = adminCommandAuditService.normalizeErrorCode(error?.code, SAFE_CODES.INTERNAL_ERROR);
      await interaction.reply({
        content:
          auditCode === SAFE_CODES.DUPLICATE_INTERACTION
            ? buildFailureMessage(SAFE_CODES.DUPLICATE_INTERACTION)
            : 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const finishFailure = async (errorCode, nextState = {}) => {
      await adminCommandAuditService.finishFailed(auditContext, {
        errorCode,
        queueCycleId: getSafeQueueCycleId(),
        previousState,
        nextState,
        client: interaction.client,
      });
    };

    if (!targetUser || !reason || reason.length < 3 || reason.length > 200) {
      await finishFailure(SAFE_CODES.INVALID_INPUT, {
        failed: true,
        reason: 'invalid_input',
      });

      await interaction.reply({
        content: buildFailureMessage(SAFE_CODES.INVALID_INPUT),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const removeResult = queueService.removePlayerFromLobbyByDiscordId({
      lobbyDiscordId: targetUser.id,
      reason,
    });

    if (!removeResult || removeResult.success !== true) {
      const safeCode = adminCommandAuditService.normalizeErrorCode(
        removeResult?.reason || SAFE_CODES.INTERNAL_ERROR,
        SAFE_CODES.INTERNAL_ERROR,
      );

      await finishFailure(safeCode, {
        failed: true,
        reason: safeCode,
        targetDiscordId: targetUser.id,
      });

      await interaction.reply({
        content: buildFailureMessage(safeCode),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await adminCommandAuditService.finishSuccess(auditContext, {
      queueCycleId: getSafeQueueCycleId(),
      previousState,
      nextState: {
        targetDiscordId: targetUser.id,
        lobbyId: removeResult.lobbyId,
        lobbyNumber: removeResult.lobbyNumber,
        lobbyCreationType: removeResult.lobbyCreationType,
        slot: removeResult.slot,
        removedQueueEntries: removeResult.removedQueueEntries,
        removedQueueOverrideEntries: removeResult.removedQueueOverrideEntries,
        unlockedRebuild: removeResult.unlockedRebuild,
        returnedToQueue: false,
      },
      client: interaction.client,
    });

    await interaction.reply({
      content:
        `Remoção administrativa concluída.\n\n` +
        `Usuário removido da lobby: <@${targetUser.id}>\n` +
        `Lobby: ${removeResult.lobbyNumber}\n` +
        `Motivo: ${reason}\n` +
        'O jogador não voltou automaticamente para a fila e deverá entrar novamente pelo botão quando retornar.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
