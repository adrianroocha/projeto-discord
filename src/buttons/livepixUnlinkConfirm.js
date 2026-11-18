const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const livepixAccountsRepository = require('../database/livepixAccountsRepository');
const confirmationService = require('../services/accountUnlinkConfirmationService');

const PREFIX = 'livepix-unlink-confirm:';

function buildDisabledRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}${token}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Confirmar desvinculação')
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`livepix-unlink-cancel:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Cancelar')
      .setDisabled(true),
  );
}

module.exports = {
  customIdPrefix: PREFIX,

  async execute(interaction) {
    const token = (interaction.customId || '').slice(PREFIX.length);
    const validation = confirmationService.validate(token, interaction.user.id);
    if (!validation.ok) {
      await interaction.reply({
        content:
          validation.reason === 'forbidden'
            ? 'Esta confirmação pertence a outro usuário.'
            : 'Esta confirmação é inválida, expirou ou já foi utilizada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const consumed = confirmationService.consume(token, interaction.user.id);
    if (!consumed.ok) {
      await interaction.reply({
        content: 'Esta confirmação é inválida, expirou ou já foi utilizada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetDiscordId = consumed.metadata?.targetDiscordId;
    const reason = consumed.metadata?.reason;
    if (!targetDiscordId || !reason) {
      await interaction.reply({
        content: 'Esta confirmação está inválida para desvinculação administrativa.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = livepixAccountsRepository.unlinkWithAudit({
      discordId: targetDiscordId,
      unlinkedByDiscordId: interaction.user.id,
      reason,
      unlinkedAtMs: Date.now(),
    });

    await interaction.update({
      content: result.unlinked
        ? `Desvinculação LivePix concluída para <@${targetDiscordId}>. O usuário poderá vincular novamente pelo painel LivePix. Nenhum dado da Kick foi alterado.`
        : `Nenhum vínculo LivePix ativo foi encontrado para <@${targetDiscordId}>. A conta já estava desvinculada.`,
      components: [buildDisabledRow(token)],
      allowedMentions: { parse: [] },
    });
  },
};
