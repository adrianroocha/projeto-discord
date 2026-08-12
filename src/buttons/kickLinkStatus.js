const { MessageFlags } = require('discord.js');
const config = require('../config');
const kickStatusDiagnosticsService = require('../services/kickStatusDiagnosticsService');

const READ_FAILED_CODE = 'KICK_LINK_STATUS_READ_FAILED';

module.exports = {
  customId: 'kick_link_status',

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este botão só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (config.guildId && interaction.guildId !== config.guildId) {
      await interaction.reply({
        content: 'Este botão só está disponível no servidor configurado para esta integração.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const status = await kickStatusDiagnosticsService.readLocalKickStatus({
        discordId: interaction.user.id,
        guild: interaction.guild,
      });

      const content = kickStatusDiagnosticsService.formatKickStatusContent(status, {
        includeUserLine: false,
        includeKickId: false,
        includeLinkGuidance: true,
      });

      await interaction.editReply({
        content,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.warn(
        `Falha ao consultar vínculo Kick via botão. code=${READ_FAILED_CODE} reason=${error?.code || error?.name || 'unknown_error'}`,
      );

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: `Não foi possível consultar o status no momento. Código: ${READ_FAILED_CODE}.`,
          allowedMentions: { parse: [] },
        });
        return;
      }

      await interaction.reply({
        content: `Não foi possível consultar o status no momento. Código: ${READ_FAILED_CODE}.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
