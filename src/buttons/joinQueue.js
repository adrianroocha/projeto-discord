const { MessageFlags } = require('discord.js');
const queueService = require('../services/queueService');
const queueMessageService = require('../services/queueMessageService');
const schedulerService = require('../services/schedulerService');
const subscriberEligibilityService = require('../services/subscriberEligibilityService');

function resolveQueuePriority(discordId) {
  try {
    const eligibility = subscriberEligibilityService.getEligibility(discordId, Date.now());
    const kickActive = eligibility?.sources?.kick?.active;
    const manualActive = eligibility?.sources?.manual?.active;
    const reliable =
      typeof eligibility?.eligible === 'boolean' &&
      typeof kickActive === 'boolean' &&
      typeof manualActive === 'boolean';

    if (!reliable) {
      return {
        isSubscriber: 0,
        source: 'eligibility_unavailable',
        priorityMessage:
          'Prioridade não pôde ser confirmada e será reconciliada posteriormente.',
        reliable: false,
      };
    }

    if (eligibility.eligible) {
      return {
        isSubscriber: 1,
        source: 'eligible',
        priorityMessage: 'Prioridade SUB ativa.',
        reliable: true,
      };
    }

    return {
      isSubscriber: 0,
      source: 'not_eligible',
      priorityMessage: 'Entrada como participante comum.',
      reliable: true,
    };
  } catch {
    return {
      isSubscriber: 0,
      source: 'eligibility_error',
      priorityMessage: 'Prioridade não pôde ser confirmada e será reconciliada posteriormente.',
      reliable: false,
    };
  }
}

function buildPriorityMessage(result) {
  const snapshotStatus = result?.snapshotStatus;
  const isSubscriber = result?.isSubscriber ? 1 : 0;
  const source = result?.snapshotResolution?.source;
  const reliable = result?.snapshotResolution?.reliable !== false;

  if (snapshotStatus === 'reused') {
    return isSubscriber
      ? 'Categoria SUB do ciclo atual reaproveitada.'
      : 'Categoria comum do ciclo atual reaproveitada.';
  }

  if (!reliable || source === 'eligibility_unavailable' || source === 'eligibility_error') {
    return 'Prioridade não pôde ser confirmada e será reconciliada posteriormente.';
  }

  return isSubscriber ? 'Prioridade SUB ativa.' : 'Entrada como participante comum.';
}

module.exports = {
  customId: 'join_queue',
  async execute(interaction) {
    const discordId = interaction.user.id;
    const username = `${interaction.user.username}#${interaction.user.discriminator}`;
    const displayName = interaction.member?.displayName || interaction.user.username;

    if (!schedulerService.isQueueOpen()) {
      await interaction.reply({ content: '🔒 A fila está fechada no momento.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (queueService.isUserInQueue(discordId)) {
      await interaction.reply({
        content: 'Você já está na fila.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = queueService.addToQueue({
      discordId,
      username,
      displayName,
      resolvePrioritySnapshot: () => {
        const priority = resolveQueuePriority(discordId);
        if (!priority.reliable) {
          console.warn(
            `Fila: elegibilidade SUB indisponível no ingresso; entrada sem prioridade para discordId=${discordId}`,
          );
        }

        return {
          isSubscriber: priority.isSubscriber,
          source: priority.source,
          reliable: priority.reliable,
        };
      },
    });

    if (!result || result.success === false) {
      const reason = result && result.reason;
      if (reason === 'in_forming_lobby') {
        await interaction.reply({ content: 'Você já está em uma lobby em formação.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (reason === 'already_waiting') {
        await interaction.reply({ content: 'Você já está na fila.', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({
        content: 'Não foi possível entrar na fila. Tente novamente mais tarde.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const priorityMessage = buildPriorityMessage(result);

    // success
    if (result.joinedLobby) {
      await interaction.reply({
        content: `✅ Você foi adicionado diretamente a uma lobby em formação.\n${priorityMessage}`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: `✅ Você entrou na fila com sucesso.\n${priorityMessage}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    queueMessageService.updatePanel(interaction.client).catch((error) => {
      console.error('Erro ao atualizar painel após entrar na fila:', error);
    });
  },
};
