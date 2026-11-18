const { MessageFlags } = require('discord.js');
const config = require('../config');
const livepixAccountsRepository = require('../database/livepixAccountsRepository');

module.exports = {
  customId: 'livepix-link-status',

  async execute(interaction) {
    if (!interaction.inGuild() || (config.guildId && interaction.guildId !== config.guildId)) {
      await interaction.reply({
        content: 'Este botão só está disponível no servidor configurado para esta integração.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const link = livepixAccountsRepository.findByDiscordId(interaction.user.id);
      await interaction.reply({
        content: link
          ? `Sua conta LivePix está vinculada (ID da conta: ${link.livepix_account_id}).`
          : 'Você ainda não possui uma conta LivePix vinculada.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error(`Falha ao consultar vínculo LivePix. code=${error?.code || error?.name || 'unknown_error'}`);
      await interaction.reply({
        content: 'Não foi possível consultar seu vínculo LivePix agora.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
