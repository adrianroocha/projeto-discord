const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const reconciliationService = require('../services/subscriberRoleReconciliationService');

function formatCodeSummary(codeMap, emptyLabel) {
  if (!codeMap || typeof codeMap !== 'object') {
    return emptyLabel;
  }

  const entries = Object.entries(codeMap).filter((entry) => entry[1] > 0);
  if (entries.length === 0) {
    return emptyLabel;
  }

  return entries
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map((entry) => `${entry[0]}=${entry[1]}`)
    .join(', ');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sub-reconcile')
    .setDescription('Executa reconciliação em massa do cargo SUB com base na elegibilidade atual.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Motivo da reconciliação manual em massa.')
        .setRequired(true),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        ephemeral: true,
      });
      return;
    }

    if (config.guildId && interaction.guildId !== config.guildId) {
      await interaction.reply({
        content: 'Este comando só pode ser usado no servidor configurado para o bot.',
        ephemeral: true,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: 'Você precisa da permissão de Administrator para usar este comando.',
        ephemeral: true,
      });
      return;
    }

    const reason = interaction.options.getString('motivo', true).trim();
    if (!reason) {
      await interaction.reply({
        content: 'O motivo da reconciliação é obrigatório.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    let finalMessage =
      'Reconciliação não pôde ser concluída no momento. Tente novamente em instantes.';

    try {
      const result = await reconciliationService.reconcileAll({
        client: interaction.client,
        triggeredByDiscordId: interaction.user.id,
        triggerType: 'command_sub_reconcile',
        reason,
      });

      if (result.status === 'already_running') {
        finalMessage =
          'Já existe uma reconciliação de cargo SUB em andamento. Aguarde a conclusão para iniciar outra.';
      } else {
        const lines = [
          `Reconciliação concluída com status: ${result.status}.`,
          `Candidatos: ${result.totalCandidates}`,
          `Processados: ${result.processed}`,
          `Adicionados: ${result.roleAdded}`,
          `Removidos: ${result.roleRemoved}`,
          `Já corretos: ${result.alreadyCorrect}`,
          `Ignorados: ${result.skipped}`,
          `Ignorados por código: ${formatCodeSummary(result.skippedByCode, 'nenhum')}`,
          `Falhas: ${result.failed}`,
          `Falhas por código: ${formatCodeSummary(result.failedByCode, 'nenhuma')}`,
          `Avisos de auditoria: ${formatCodeSummary(result.auditWarnings, 'nenhum')}`,
          `Descoberta completa de membros com SUB: ${result.memberRoleDiscoveryComplete ? 'sim' : 'não'}`,
          `Motivo: ${reason}`,
        ];

        if (Array.isArray(result.warnings) && result.warnings.length > 0) {
          lines.push(`Avisos: ${result.warnings.join(', ')}`);
        }

        finalMessage = lines.join('\n');
      }
    } catch (_error) {
      finalMessage =
        'Reconciliação não pôde ser concluída no momento. Nenhuma alteração fora da sincronização segura foi aplicada.';
    }

    try {
      await interaction.editReply(finalMessage);
    } catch (_error) {
      // best-effort: avoid command crash if Discord edit fails
    }
  },
};
