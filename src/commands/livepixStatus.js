const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const livepixAuthService = require('../services/livepixAuthService');

function getSafeErrorCode(error) {
  const knownCodes = new Set([
    'MISSING_CONFIG',
    'INVALID_TOKEN_RESPONSE',
    'INVALID_ACCOUNT_RESPONSE',
    'REQUEST_TIMEOUT',
    'NETWORK_ERROR',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'RATE_LIMITED',
    'UPSTREAM_UNAVAILABLE',
    'UPSTREAM_ERROR',
  ]);
  return knownCodes.has(error?.code) ? error.code : 'CONNECTION_FAILED';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('livepix-status')
    .setDescription('Testa a autenticação LivePix e consulta a conta autenticada.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: 'Você precisa da permissão de Administrator para usar este comando.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const account = await livepixAuthService.getAuthenticatedAccount();
      const username = account.username
        .replace(/[\r\n]/g, '')
        .replace(/[`\\]/g, '')
        .slice(0, 100);
      await interaction.editReply({
        content: `Conexão LivePix: ativa\nConta autenticada: ${username}`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      const code = getSafeErrorCode(error);
      console.warn(`LivePix connection diagnostic failed code=${code}`);
      await interaction.editReply(`Conexão LivePix não verificada. Código: ${code}.`);
    }
  },
};
