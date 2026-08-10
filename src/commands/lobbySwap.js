const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const queueService = require('../services/queueService');
const adminCommandAuditService = require('../services/adminCommandAuditService');
const operationalAuthorizationService = require('../services/operationalAuthorizationService');

const SAFE_CODES = {
  OK: 'OK',
  MISSING_PERMISSION: 'MISSING_PERMISSION',
  MEMBER_UNAVAILABLE: 'MEMBER_UNAVAILABLE',
  INVALID_INPUT: 'INVALID_INPUT',
  SAME_USER: 'SAME_USER',
  LOBBY_PLAYER_NOT_FOUND: 'LOBBY_PLAYER_NOT_FOUND',
  QUEUE_PLAYER_NOT_FOUND: 'QUEUE_PLAYER_NOT_FOUND',
  LOBBY_IMMUTABLE: 'LOBBY_IMMUTABLE',
  AMBIGUOUS_LOBBY_MEMBERSHIP: 'AMBIGUOUS_LOBBY_MEMBERSHIP',
  PLAYER_ALREADY_IN_FORMING_LOBBY: 'PLAYER_ALREADY_IN_FORMING_LOBBY',
  PLAYER_ALREADY_IN_QUEUE: 'PLAYER_ALREADY_IN_QUEUE',
  DUPLICATE_INTERACTION: 'DUPLICATE_INTERACTION',
  QUEUE_POSITION_CONFLICT: 'QUEUE_POSITION_CONFLICT',
  LOBBY_POSITION_CONFLICT: 'LOBBY_POSITION_CONFLICT',
  SWAP_TRANSACTION_FAILED: 'SWAP_TRANSACTION_FAILED',
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
    case SAFE_CODES.SAME_USER:
      return 'Os usuários de lobby e fila devem ser diferentes.';
    case SAFE_CODES.MEMBER_UNAVAILABLE:
      return 'Não foi possível localizar um dos usuários no servidor.';
    case SAFE_CODES.LOBBY_PLAYER_NOT_FOUND:
      return 'O usuário da lobby não está em uma lobby em formação.';
    case SAFE_CODES.QUEUE_PLAYER_NOT_FOUND:
      return 'O usuário da fila não está aguardando na fila.';
    case SAFE_CODES.LOBBY_IMMUTABLE:
      return 'Não é permitido trocar jogador de lobby em andamento.';
    case SAFE_CODES.AMBIGUOUS_LOBBY_MEMBERSHIP:
      return 'Não foi possível determinar de forma única a lobby em formação desse usuário.';
    case SAFE_CODES.PLAYER_ALREADY_IN_FORMING_LOBBY:
      return 'O usuário da fila já está em outra lobby em formação.';
    case SAFE_CODES.PLAYER_ALREADY_IN_QUEUE:
      return 'O usuário da lobby já está simultaneamente na fila. Corrija a inconsistência antes da troca.';
    case SAFE_CODES.QUEUE_POSITION_CONFLICT:
      return 'Conflito de posição na fila detectado. Tente novamente.';
    case SAFE_CODES.LOBBY_POSITION_CONFLICT:
      return 'Conflito de slot na lobby detectado. Tente novamente.';
    case SAFE_CODES.DUPLICATE_INTERACTION:
      return 'Esta interação já foi processada anteriormente.';
    case SAFE_CODES.INVALID_INPUT:
      return 'Parâmetros inválidos para executar a troca administrativa.';
    case SAFE_CODES.SWAP_TRANSACTION_FAILED:
      return 'Falha transacional ao aplicar a troca. Nenhuma alteração foi persistida.';
    default:
      return 'Não foi possível concluir a troca administrativa no momento.';
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lobby-swap')
    .setDescription('Troca administrativamente um jogador da lobby em formação por um jogador da fila.')
    .addUserOption((option) =>
      option
        .setName('usuario_lobby')
        .setDescription('Jogador atualmente na lobby em formação')
        .setRequired(true),
    )
    .addUserOption((option) =>
      option
        .setName('usuario_fila')
        .setDescription('Jogador atualmente aguardando na fila')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Motivo da troca administrativa')
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(200),
    ),

  async execute(interaction) {
    const queueCycleId = getSafeQueueCycleId();
    const previousState = getSafeOperationalState();

    const lobbyUser = interaction.options.getUser('usuario_lobby');
    const queueUser = interaction.options.getUser('usuario_fila');
    const reason = String(interaction.options.getString('motivo') || '').trim();

    const authorization = await operationalAuthorizationService.authorize(interaction);
    if (!authorization.allowed) {
      let deniedAudit;
      try {
        deniedAudit = await adminCommandAuditService.beginRequired(interaction, {
          commandName: 'lobby-swap',
          parameters: {
            usuario_lobby: lobbyUser?.id || null,
            usuario_fila: queueUser?.id || null,
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
        commandName: 'lobby-swap',
        parameters: {
          usuario_lobby: lobbyUser?.id || null,
          usuario_fila: queueUser?.id || null,
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

    if (!lobbyUser || !queueUser || !reason || reason.length < 3 || reason.length > 200) {
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

    if (lobbyUser.id === queueUser.id) {
      await finishFailure(SAFE_CODES.SAME_USER, {
        failed: true,
        reason: 'same_user',
      });

      await interaction.reply({
        content: buildFailureMessage(SAFE_CODES.SAME_USER),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await interaction.guild.members.fetch(lobbyUser.id);
      await interaction.guild.members.fetch(queueUser.id);
    } catch {
      await finishFailure(SAFE_CODES.MEMBER_UNAVAILABLE, {
        failed: true,
        reason: 'member_unavailable',
      });

      await interaction.reply({
        content: buildFailureMessage(SAFE_CODES.MEMBER_UNAVAILABLE),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const swapResult = queueService.swapLobbyPlayerWithQueuePlayer({
      lobbyDiscordId: lobbyUser.id,
      queueDiscordId: queueUser.id,
      reason,
    });

    if (!swapResult || swapResult.success !== true) {
      const safeCode = adminCommandAuditService.normalizeErrorCode(
        swapResult?.reason || SAFE_CODES.INTERNAL_ERROR,
        SAFE_CODES.INTERNAL_ERROR,
      );

      await finishFailure(safeCode, {
        failed: true,
        reason: safeCode,
        usuario_lobby: lobbyUser.id,
        usuario_fila: queueUser.id,
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
        usuario_lobby: lobbyUser.id,
        usuario_fila: queueUser.id,
        lobbyId: swapResult.lobbyId,
        lobbyNumber: swapResult.lobbyNumber,
        slot: swapResult.slot,
        queuePositionAfter: swapResult.movedOutQueuePosition,
        movedOutQueueOrderKey: swapResult.movedOutQueueOrderKey,
        movedOutEffectiveSortPriority: swapResult.movedOutEffectiveSortPriority,
        rebuildLocked: swapResult.lobbyLockedForRebuild === true,
      },
      client: interaction.client,
    });

    await interaction.reply({
      content:
        `Troca administrativa concluída.\n\n` +
        `Saiu da lobby: <@${lobbyUser.id}>\n` +
        `Entrou na lobby: <@${queueUser.id}>\n` +
        `Lobby: ${swapResult.lobbyNumber}\n` +
        `Slot preservado: ${swapResult.slot}\n` +
        `Nova posição de <@${lobbyUser.id}> na fila: ${swapResult.movedOutQueuePosition}\n` +
        `Motivo: ${reason}\n\n` +
        'A troca altera somente as posições atuais. Cargos, elegibilidade, cooldown e prioridade permanente não foram modificados.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
