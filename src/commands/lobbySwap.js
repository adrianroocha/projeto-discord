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
  PARTICIPANT_NOT_FOUND: 'PARTICIPANT_NOT_FOUND',
  LOBBY_IMMUTABLE: 'LOBBY_IMMUTABLE',
  LOBBY_STATE_CONFLICT: 'LOBBY_STATE_CONFLICT',
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
      return 'Os usuários informados devem ser diferentes.';
    case SAFE_CODES.MEMBER_UNAVAILABLE:
      return 'Não foi possível localizar um dos usuários no servidor.';
    case SAFE_CODES.PARTICIPANT_NOT_FOUND:
      return 'Um dos usuários informados não está na fila nem em lobby em formação no ciclo atual.';
    case SAFE_CODES.LOBBY_IMMUTABLE:
      return 'Não é permitido trocar jogador de lobby em andamento.';
    case SAFE_CODES.LOBBY_STATE_CONFLICT:
      return 'Conflito de estado detectado para um dos participantes. Nenhuma alteração foi aplicada.';
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

function readUserOption(options, currentName, legacyName) {
  const currentValue = options.getUser(currentName);
  if (currentValue) {
    return {
      user: currentValue,
      source: currentName,
      usedLegacy: false,
    };
  }

  const legacyValue = legacyName ? options.getUser(legacyName) : null;
  return {
    user: legacyValue,
    source: legacyValue ? legacyName : null,
    usedLegacy: Boolean(legacyValue),
  };
}

function formatLocation(location) {
  if (!location || typeof location !== 'object') {
    return 'posição indisponível';
  }

  if (location.state === 'queue') {
    if (Number.isSafeInteger(location.queuePosition) && location.queuePosition > 0) {
      return `fila (posição ${location.queuePosition})`;
    }
    return 'fila';
  }

  if (location.state === 'forming_lobby') {
    const lobbyLabel = Number.isSafeInteger(location.lobbyNumber)
      ? `Lobby #${location.lobbyNumber}`
      : 'Lobby em formação';

    if (Number.isSafeInteger(location.slot) && location.slot > 0) {
      return `${lobbyLabel} (slot ${location.slot})`;
    }
    return lobbyLabel;
  }

  return 'posição indisponível';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lobby-swap')
    .setDescription('Troca administrativamente dois participantes mutáveis do ciclo atual.')
    .addUserOption((option) =>
      option
        .setName('usuario_a')
        .setDescription('Primeiro participante da troca')
        .setRequired(true),
    )
    .addUserOption((option) =>
      option
        .setName('usuario_b')
        .setDescription('Segundo participante da troca')
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

    const usuarioAOption = readUserOption(interaction.options, 'usuario_a', 'usuario_lobby');
    const usuarioBOption = readUserOption(interaction.options, 'usuario_b', 'usuario_fila');
    const userA = usuarioAOption.user;
    const userB = usuarioBOption.user;
    const usedLegacyOptionNames = usuarioAOption.usedLegacy || usuarioBOption.usedLegacy;
    const reason = String(interaction.options.getString('motivo') || '').trim();

    const authorization = await operationalAuthorizationService.authorize(interaction);
    if (!authorization.allowed) {
      let deniedAudit;
      try {
        deniedAudit = await adminCommandAuditService.beginRequired(interaction, {
          commandName: 'lobby-swap',
          parameters: {
            usuario_a: userA?.id || null,
            usuario_b: userB?.id || null,
            motivo: reason,
            compat_legacy_option_names: usedLegacyOptionNames,
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
          usuario_a: userA?.id || null,
          usuario_b: userB?.id || null,
          motivo: reason,
          compat_legacy_option_names: usedLegacyOptionNames,
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

    if (!userA || !userB || !reason || reason.length < 3 || reason.length > 200) {
      await finishFailure(SAFE_CODES.INVALID_INPUT, {
        failed: true,
        reason: 'invalid_input',
        compatLegacyOptionNames: usedLegacyOptionNames,
      });

      await interaction.reply({
        content: buildFailureMessage(SAFE_CODES.INVALID_INPUT),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (userA.id === userB.id) {
      await finishFailure(SAFE_CODES.SAME_USER, {
        failed: true,
        reason: 'same_user',
        usuarioADiscordId: userA.id,
        usuarioBDiscordId: userB.id,
      });

      await interaction.reply({
        content: buildFailureMessage(SAFE_CODES.SAME_USER),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await interaction.guild.members.fetch(userA.id);
      await interaction.guild.members.fetch(userB.id);
    } catch {
      await finishFailure(SAFE_CODES.MEMBER_UNAVAILABLE, {
        failed: true,
        reason: 'member_unavailable',
        usuarioADiscordId: userA?.id || null,
        usuarioBDiscordId: userB?.id || null,
      });

      await interaction.reply({
        content: buildFailureMessage(SAFE_CODES.MEMBER_UNAVAILABLE),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const swapResult =
      typeof queueService.swapParticipantsInCurrentCycle === 'function'
        ? queueService.swapParticipantsInCurrentCycle({
            discordIdA: userA.id,
            discordIdB: userB.id,
            reason,
          })
        : queueService.swapLobbyPlayerWithQueuePlayer({
            lobbyDiscordId: userA.id,
            queueDiscordId: userB.id,
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
        usuarioADiscordId: userA.id,
        usuarioBDiscordId: userB.id,
        compatLegacyOptionNames: usedLegacyOptionNames,
        stateA: swapResult?.stateA || null,
        stateB: swapResult?.stateB || null,
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
        usuarioADiscordId: userA.id,
        usuarioBDiscordId: userB.id,
        origemA: swapResult.userA?.origin?.state || null,
        origemB: swapResult.userB?.origin?.state || null,
        destinoA: swapResult.userA?.destination?.state || null,
        destinoB: swapResult.userB?.destination?.state || null,
        origemADetalhe: formatLocation(swapResult.userA?.origin),
        origemBDetalhe: formatLocation(swapResult.userB?.origin),
        destinoADetalhe: formatLocation(swapResult.userA?.destination),
        destinoBDetalhe: formatLocation(swapResult.userB?.destination),
        lobbiesEnvolvidas: swapResult.affectedLobbyNumbers || [],
        lobbiesTravadas: swapResult.lockedLobbyNumbers || [],
        compatLegacyOptionNames: usedLegacyOptionNames,
      },
      client: interaction.client,
    });

    const sameLobbySwap =
      swapResult.userA?.origin?.state === 'forming_lobby' &&
      swapResult.userB?.origin?.state === 'forming_lobby' &&
      swapResult.userA?.origin?.lobbyId &&
      swapResult.userA.origin.lobbyId === swapResult.userB?.origin?.lobbyId;

    const lobbiesLine =
      Array.isArray(swapResult.affectedLobbyNumbers) && swapResult.affectedLobbyNumbers.length
        ? `Lobbies envolvidas: ${swapResult.affectedLobbyNumbers.map((value) => `#${value}`).join(', ')}`
        : 'Lobbies envolvidas: nenhuma';

    const scenarioLine = sameLobbySwap
      ? 'Cenário: dois slots da mesma lobby em formação.'
      : 'Cenário: troca entre participantes mutáveis do ciclo atual.';

    await interaction.reply({
      content:
        `Troca administrativa concluída.\n\n` +
        `<@${userA.id}>: ${formatLocation(swapResult.userA?.origin)} -> ${formatLocation(swapResult.userA?.destination)}\n` +
        `<@${userB.id}>: ${formatLocation(swapResult.userB?.origin)} -> ${formatLocation(swapResult.userB?.destination)}\n` +
        `${lobbiesLine}\n` +
        `${scenarioLine}\n` +
        `Motivo: ${reason}\n\n` +
        'A troca altera somente as posições atuais. Cargos, elegibilidade e snapshots não foram modificados.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
