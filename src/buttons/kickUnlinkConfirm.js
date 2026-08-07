const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const kickAccountsRepository = require('../database/kickAccountsRepository');
const confirmationService = require('../services/kickUnlinkConfirmationService');
const subscriberRoleAutoSyncService = require('../services/subscriberRoleAutoSyncService');

const PREFIX = 'kick-unlink-confirm:';

function buildDisabledRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`kick-unlink-confirm:${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Confirmar desvinculação')
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`kick-unlink-cancel:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancelar')
      .setDisabled(true),
  );
}

function getToken(customId) {
  return customId.slice(PREFIX.length);
}

function mapEligibilityLabel(value) {
  if (value === true) {
    return 'ativa';
  }

  if (value === false) {
    return 'inativa';
  }

  return 'indisponível';
}

function mapRoleStateLabel(roleState) {
  if (roleState === 'added') {
    return 'adicionado';
  }

  if (roleState === 'removed') {
    return 'removido';
  }

  if (roleState === 'kept') {
    return 'mantido';
  }

  return 'sincronização pendente';
}

function formatSources(sources) {
  const activeSources = [];
  if (sources?.kick) {
    activeSources.push('- Kick');
  }
  if (sources?.manual) {
    activeSources.push('- Concessão manual');
  }
  return activeSources.length > 0 ? activeSources.join('\n') : '- nenhuma';
}

module.exports = {
  customIdPrefix: PREFIX,

  async execute(interaction) {
    const token = getToken(interaction.customId || '');
    const validation = confirmationService.validate(token, interaction.user.id);

    if (!validation.ok) {
      const reasonMessage =
        validation.reason === 'forbidden'
          ? 'Esta confirmação pertence a outro usuário.'
          : 'Esta confirmação é inválida, expirou ou já foi utilizada.';

      await interaction.reply({
        content: reasonMessage,
        ephemeral: true,
      });
      return;
    }

    const consumed = confirmationService.consume(token, interaction.user.id);
    if (!consumed.ok) {
      await interaction.reply({
        content: 'Esta confirmação é inválida, expirou ou já foi utilizada.',
        ephemeral: true,
      });
      return;
    }

    const targetDiscordId = consumed.metadata?.targetDiscordId;
    const reason = consumed.metadata?.reason;
    if (!targetDiscordId || !reason) {
      await interaction.reply({
        content: 'Esta confirmação está inválida para desvinculação administrativa.',
        ephemeral: true,
      });
      return;
    }

    const existingLink = kickAccountsRepository.findByDiscordId(targetDiscordId);
    if (!existingLink) {
      await interaction.update({
        content: `Nenhum vínculo ativo foi encontrado para <@${targetDiscordId}>. A conta já estava desvinculada.`,
        components: [buildDisabledRow(token)],
      });
      return;
    }

    const unlinkResult = kickAccountsRepository.unlinkWithAudit({
      discordId: targetDiscordId,
      unlinkedByDiscordId: interaction.user.id,
      reason,
      unlinkedAtMs: Date.now(),
    });

    if (!unlinkResult.unlinked) {
      await interaction.update({
        content: `Nenhum vínculo ativo foi encontrado para <@${targetDiscordId}>. A conta já estava desvinculada.`,
        components: [buildDisabledRow(token)],
      });
      return;
    }

    const syncResult = await subscriberRoleAutoSyncService.syncAfterEligibilityChange({
      discordId: targetDiscordId,
      triggerType: 'kick_unlink',
      reason: `Desvinculação Kick administrativa: ${reason}`,
      triggeredByDiscordId: interaction.user.id,
      client: interaction.client,
    });

    const lines = [
      `Desvinculação concluída para <@${targetDiscordId}>. O usuário pode vincular novamente pelo painel ou por /kick-link.`,
      `Elegibilidade final: ${mapEligibilityLabel(syncResult.eligibility)}`,
      'Fontes ativas:',
      formatSources(syncResult.sources),
      `Estado do cargo SUB: ${mapRoleStateLabel(syncResult.roleState)}`,
    ];

    if (syncResult.status === 'warning') {
      lines.push('A desvinculação foi concluída, mas a sincronização automática do cargo ficou pendente. Use /sub-sync para reconciliar.');
    }

    await interaction.update({
      content: lines.join('\n'),
      components: [buildDisabledRow(token)],
    });
  },
};
