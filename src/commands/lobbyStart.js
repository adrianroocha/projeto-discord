const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const queueService = require('../services/queueService');
const adminCommandAuditService = require('../services/adminCommandAuditService');
const operationalAuthorizationService = require('../services/operationalAuthorizationService');

const STARTABLE_LOBBY_STATUSES = new Set(['forming', 'open']);

function buildAuthorizationReplyContent(code) {
  if (code === operationalAuthorizationService.codes.MEMBER_UNAVAILABLE) {
    return 'Não foi possível validar sua autorização operacional neste servidor. Operação recusada.';
  }

  return 'Você precisa de autorização operacional para executar este comando.';
}

function validateLobbyNumber(value) {
  if (value === null || value === undefined) {
    return {
      ok: false,
      errorCode: 'LOBBY_NUMBER_REQUIRED',
      replyContent: 'O número da lobby é obrigatório.',
      reason: 'lobby_number_required',
    };
  }

  if (!Number.isInteger(value) || value < 1) {
    return {
      ok: false,
      errorCode: 'INVALID_LOBBY_NUMBER',
      replyContent: 'O número da lobby deve ser um inteiro maior ou igual a 1.',
      reason: 'invalid_lobby_number',
    };
  }

  return { ok: true };
}

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lobby-start')
    .setDescription('Inicia um lobby em formação.')
    .addIntegerOption((option) =>
      option
        .setName('numero')
        .setDescription('Número público da lobby para iniciar')
        .setRequired(true)
        .setMinValue(1),
    ),
  async execute(interaction) {
    const lobbyNumberOption = interaction.options.getInteger('numero');
    const previousState = getSafeOperationalState();
    const cycleId = getSafeQueueCycleId();

    const authorization = await operationalAuthorizationService.authorize(interaction);
    if (!authorization.allowed) {
      let deniedAudit;
      try {
        deniedAudit = await adminCommandAuditService.beginRequired(interaction, {
          commandName: 'lobby-start',
          parameters: { numero: lobbyNumberOption },
          queueCycleId: cycleId,
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
        queueCycleId: cycleId,
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
        commandName: 'lobby-start',
        parameters: { numero: lobbyNumberOption },
        queueCycleId: cycleId,
        previousState,
      });
    } catch {
      await interaction.reply({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const validation = validateLobbyNumber(lobbyNumberOption);
    if (!validation.ok) {
      await adminCommandAuditService.finishFailed(auditContext, {
        errorCode: validation.errorCode,
        queueCycleId: cycleId,
        previousState,
        nextState: {
          failed: true,
          reason: validation.reason,
        },
        client: interaction.client,
      });

      await interaction.reply({
        content: validation.replyContent,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const activeLobbies = queueService.getActiveLobbies();
    const targetLobby = activeLobbies.find(
      (lobby) =>
        Number(lobby.lobbyNumber) === Number(lobbyNumberOption) && STARTABLE_LOBBY_STATUSES.has(lobby.status),
    ) || null;

    if (!targetLobby) {
      await adminCommandAuditService.finishFailed(auditContext, {
        errorCode: 'LOBBY_NOT_FOUND',
        queueCycleId: cycleId,
        previousState,
        nextState: {
          failed: true,
          reason: 'lobby_not_startable',
          lobbyNumber: lobbyNumberOption,
        },
        client: interaction.client,
      });

      await interaction.reply({
        content: 'Não foi possível iniciar essa lobby. Verifique se ela está disponível para início.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const started = queueService.startLobbyByNumber(lobbyNumberOption);
    if (!started) {
      await adminCommandAuditService.finishFailed(auditContext, {
        errorCode: 'LOBBY_NOT_FOUND',
        queueCycleId: cycleId,
        previousState,
        nextState: {
          failed: true,
          reason: 'lobby_start_failed',
          lobbyNumber: lobbyNumberOption,
        },
        client: interaction.client,
      });

      await interaction.reply({
        content: 'Não foi possível iniciar essa lobby. Verifique se ela está disponível para início.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await adminCommandAuditService.finishSuccess(auditContext, {
      queueCycleId: getSafeQueueCycleId(),
      previousState,
      nextState: {
        lobbyId: targetLobby ? targetLobby.id : null,
        lobbyNumber: lobbyNumberOption,
        previousLobbyState: targetLobby ? targetLobby.status : null,
        nextLobbyState: 'in_game',
      },
      client: interaction.client,
    });

    await interaction.reply({
      content: `Lobby #${lobbyNumberOption} iniciada com sucesso.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
