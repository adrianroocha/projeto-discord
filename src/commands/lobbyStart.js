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
    .setName('lobby-start')
    .setDescription('Inicia um lobby em formação.')
    .addIntegerOption((option) =>
      option
        .setName('numero')
        .setDescription('Número público da lobby para iniciar')
        .setRequired(false),
    ),
  async execute(interaction) {
    const lobbyNumberOption = interaction.options.getInteger('numero');
    const previousState = getSafeOperationalState();
    const cycleId = getSafeQueueCycleId();

    const member = interaction.member;
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      const deniedAudit = await adminCommandAuditService.beginBestEffort(interaction, {
        commandName: 'lobby-start',
        parameters: { numero: lobbyNumberOption },
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
        content: 'Você precisa de permissão de Gerenciar Servidor para executar este comando.',
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

    const formingLobbies = queueService.getActiveLobbies('forming');
    if (!formingLobbies.length) {
      await adminCommandAuditService.finishFailed(auditContext, {
        errorCode: 'LOBBY_NOT_FOUND',
        queueCycleId: cycleId,
        previousState,
        nextState: {
          failed: true,
          reason: 'no_forming_lobbies',
        },
        client: interaction.client,
      });

      await interaction.reply({
        content: 'Não há lobbies em formação no momento.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let lobbyNumber = lobbyNumberOption;

    if (!lobbyNumber) {
      if (formingLobbies.length === 1) {
        lobbyNumber = formingLobbies[0].lobbyNumber;
      } else {
        await adminCommandAuditService.finishFailed(auditContext, {
          errorCode: 'INVALID_INPUT',
          queueCycleId: cycleId,
          previousState,
          nextState: {
            failed: true,
            reason: 'missing_lobby_number_with_multiple_forming',
            formingCount: formingLobbies.length,
          },
          client: interaction.client,
        });

        const lobbyList = formingLobbies.map((lobby) => `• Lobby #${lobby.lobbyNumber}`).join('\n');
        await interaction.reply({
          content: `Lobbies em formação:\n${lobbyList}\n\nUse /lobby-start numero:<NÚMERO> para iniciar uma lobby.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const targetLobby = formingLobbies.find((lobby) => Number(lobby.lobbyNumber) === Number(lobbyNumber)) || null;

    const started = queueService.startLobbyByNumber(lobbyNumber);
    if (!started) {
      await adminCommandAuditService.finishFailed(auditContext, {
        errorCode: 'LOBBY_NOT_FOUND',
        queueCycleId: cycleId,
        previousState,
        nextState: {
          failed: true,
          reason: 'lobby_not_in_forming_state',
          lobbyNumber,
        },
        client: interaction.client,
      });

      await interaction.reply({
        content: 'Não foi possível iniciar essa lobby. Verifique se ela ainda está em formação.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await queueMessageService.updatePanel(interaction.client);

    await adminCommandAuditService.finishSuccess(auditContext, {
      queueCycleId: getSafeQueueCycleId(),
      previousState,
      nextState: {
        lobbyId: targetLobby ? targetLobby.id : null,
        lobbyNumber,
        previousLobbyState: targetLobby ? targetLobby.status : 'forming',
        nextLobbyState: 'in_game',
      },
      client: interaction.client,
    });

    await interaction.reply({
      content: `Lobby #${lobbyNumber} iniciada com sucesso.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
