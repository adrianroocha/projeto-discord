const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const queueService = require('../services/queueService');
const queueMessageService = require('../services/queueMessageService');
const adminCommandAuditService = require('../services/adminCommandAuditService');

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

    const member = interaction.member;
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && !member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      const deniedAudit = await adminCommandAuditService.beginBestEffort(interaction, {
        commandName: 'lobby-form-force',
        parameters: { quantidade },
        queueCycleId: cycleId,
        previousState,
      });

      if (deniedAudit) {
        await adminCommandAuditService.finishDenied(deniedAudit, {
          errorCode: 'MISSING_PERMISSION',
          queueCycleId: cycleId,
          previousState,
          nextState: {
            denied: true,
            reason: 'missing_permission',
          },
          client: interaction.client,
        });
      }

      await interaction.reply({
        content: 'Você precisa ser Administrador ou ter permissão de Gerenciar Servidor para usar este comando.',
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

    await queueMessageService.updatePanel(interaction.client);

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
