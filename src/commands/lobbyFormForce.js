const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const queueService = require('../services/queueService');
const adminCommandAuditService = require('../services/adminCommandAuditService');
const operationalAuthorizationService = require('../services/operationalAuthorizationService');

function buildAuthorizationReplyContent(code) {
  if (code === operationalAuthorizationService.codes.MEMBER_UNAVAILABLE) {
    return 'Não foi possível validar sua autorização operacional neste servidor. Operação recusada.';
  }

  return 'Você precisa de autorização operacional para usar este comando.';
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
    .setName('lobby-form-force')
    .setDescription('Cria manualmente uma lobby em formação com a quantidade solicitada de jogadores.')
    .addIntegerOption((option) =>
      option
        .setName('quantidade')
        .setDescription('Quantidade de jogadores para preencher a lobby (1-4)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(4),
    ),

  async execute(interaction) {
    const quantidade = interaction.options.getInteger('quantidade');
    const previousState = getSafeOperationalState();
    const cycleId = getSafeQueueCycleId();

    const authorization = await operationalAuthorizationService.authorize(interaction);
    if (!authorization.allowed) {
      let deniedAudit;
      try {
        deniedAudit = await adminCommandAuditService.beginRequired(interaction, {
          commandName: 'lobby-form-force',
          parameters: { quantidade },
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
        commandName: 'lobby-form-force',
        parameters: { quantidade },
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

    if (!Number.isInteger(quantidade) || quantidade < 1) {
      await adminCommandAuditService.finishFailed(auditContext, {
        errorCode: 'INVALID_INPUT',
        queueCycleId: cycleId,
        previousState,
        nextState: {
          requestedQuantity: quantidade,
          failed: true,
          reason: 'invalid_input',
        },
        client: interaction.client,
      });

      await interaction.reply({
        content: '❌ Parâmetro quantidade inválido.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = queueService.forceCreateLobby(quantidade);
    if (!result || result.success === false) {
      const available = result ? result.available : 0;

      await adminCommandAuditService.finishFailed(auditContext, {
        errorCode: 'INSUFFICIENT_PLAYERS',
        queueCycleId: cycleId,
        previousState,
        nextState: {
          requestedQuantity: quantidade,
          availablePlayers: available,
          failed: true,
          reason: 'insufficient_players',
        },
        client: interaction.client,
      });

      await interaction.reply({
        content: `❌ Não há jogadores suficientes na fila. Jogadores disponíveis: ${available}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const entries = result.entries;
    const lines = entries.map((entry, index) => {
      const position = index + 1;
      const name = entry.display_name?.trim() ? entry.display_name : entry.username;
      return `${position}. ${name}`;
    });

    await adminCommandAuditService.finishSuccess(auditContext, {
      queueCycleId: getSafeQueueCycleId(),
      previousState,
      nextState: {
        requestedQuantity: quantidade,
        playersUsed: entries.length,
        lobbyId: result.lobbyId,
        lobbyNumber: result.lobbyNumber,
        queueLengthAfter: queueService.getQueue().length,
      },
      client: interaction.client,
    });

    await interaction.reply({
      content: `✅ Lobby criada com sucesso.\n\nJogadores:\n${lines.join('\n')}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
