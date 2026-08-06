const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const manualSubGrantService = require('../services/manualSubGrantService');

function toDiscordTimestamp(ms) {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sub-grant')
    .setDescription('Concede manualmente benefício SUB para elegibilidade futura.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Usuário que receberá a concessão manual.')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Motivo da concessão (ex.: Pix, cortesia, patrocinador).')
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('dias')
        .setDescription('Duração em dias (1-365). Se omitido, sem vencimento.')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(365),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
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

    const targetUser = interaction.options.getUser('usuario', true);
    if (targetUser.bot) {
      await interaction.reply({
        content: 'Não é possível conceder benefício manual para bots.',
        ephemeral: true,
      });
      return;
    }

    const reason = interaction.options.getString('motivo', true);
    const days = interaction.options.getInteger('dias', false);

    try {
      const result = manualSubGrantService.createGrant({
        discordId: targetUser.id,
        grantedByDiscordId: interaction.user.id,
        reason,
        days,
      });

      if (!result.created && result.reason === 'active_exists') {
        await interaction.reply({
          content: 'Já existe uma concessão manual ativa para este usuário.',
          ephemeral: true,
        });
        return;
      }

      const grant = result.grant;
      const expiresLabel = grant.expiresAtMs ? toDiscordTimestamp(grant.expiresAtMs) : 'sem vencimento';

      await interaction.reply({
        content: [
          'Concessão manual registrada com sucesso.',
          `Usuário: <@${grant.discordId}>`,
          `Motivo: ${grant.reason}`,
          `Administrador: <@${grant.grantedByDiscordId}>`,
          `Concedida em: ${toDiscordTimestamp(grant.grantedAtMs)}`,
          `Vencimento: ${expiresLabel}`,
          'Observação: cargo e prioridade serão sincronizados em etapa posterior.',
        ].join('\n'),
        ephemeral: true,
      });
    } catch (error) {
      await interaction.reply({
        content: `Não foi possível registrar a concessão manual: ${error.message}`,
        ephemeral: true,
      });
    }
  },
};
