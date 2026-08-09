const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const schedulerService = require('../services/schedulerService');
const queueService = require('../services/queueService');
const adminCommandAuditService = require('../services/adminCommandAuditService');

function hasManagePermission(interaction) {
  if (!interaction.memberPermissions || typeof interaction.memberPermissions.has !== 'function') {
    return true;
  }

  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  );
}

function getSafeQueueCycleId() {
  try {
    return queueService.getCurrentQueueCycleId();
  } catch {
    return null;
  }
}

function getSafeSchedulerState() {
  try {
    return schedulerService.getStatus();
  } catch {
    return null;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scheduler-open')
    .setDescription('Abre a fila imediatamente e reinicia o ciclo atual.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    const previousState = getSafeSchedulerState();
    const cycleBefore = getSafeQueueCycleId();

    if (!hasManagePermission(interaction)) {
      const deniedAudit = await adminCommandAuditService.beginBestEffort(interaction, {
        commandName: 'scheduler-open',
        parameters: {},
        queueCycleId: cycleBefore,
        previousState,
      });

      if (deniedAudit) {
        await adminCommandAuditService.finishDenied(deniedAudit, {
          errorCode: 'MISSING_PERMISSION',
          queueCycleId: cycleBefore,
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
        commandName: 'scheduler-open',
        parameters: {},
        queueCycleId: cycleBefore,
        previousState,
      });
    } catch {
      await interaction.reply({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      await schedulerService.openQueue(interaction.client, { manual: true });
    } catch (error) {
      await adminCommandAuditService.finishFailed(auditContext, {
        errorCode: adminCommandAuditService.normalizeErrorCode(error?.code, 'QUEUE_STATE_ERROR'),
        queueCycleId: getSafeQueueCycleId(),
        previousState,
        nextState: {
          attemptedManualOpen: true,
          failed: true,
        },
        client: interaction.client,
      });
      throw error;
    }

    const nextState = getSafeSchedulerState();
    const cycleAfter = getSafeQueueCycleId();
    await adminCommandAuditService.finishSuccess(auditContext, {
      queueCycleId: cycleAfter,
      previousState,
      nextState: {
        ...nextState,
        cycleBefore,
        cycleAfter,
        manualCycleReset: true,
      },
      client: interaction.client,
    });

    await interaction.editReply('✅ Fila aberta manualmente.');
  },
};
