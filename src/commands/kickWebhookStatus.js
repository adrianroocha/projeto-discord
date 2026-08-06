const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const kickWebhookStatusService = require('../services/kickWebhookStatusService');

function toDiscordTimestamp(ms) {
  const unixSeconds = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(unixSeconds)) {
    return 'indisponível';
  }
  return `<t:${unixSeconds}:F>`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick-webhook-status')
    .setDescription('Mostra o estado do recebimento de webhooks da Kick.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

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

    const status = kickWebhookStatusService.getStatus();

    const lines = [
      `Webhook configurado: ${status.webhookConfigured ? 'sim' : 'não'}`,
      `Broadcaster configurado: ${status.broadcasterConfigured ? 'sim' : 'não'}`,
      `Eventos válidos auditados: ${status.auditedEventsCount}`,
      `Follows recebidos: ${status.followEventsCount}`,
    ];

    if (!status.latestEvent) {
      lines.push('', 'Nenhum webhook válido recebido até o momento.');
      await interaction.reply({
        content: lines.join('\n'),
        ephemeral: true,
      });
      return;
    }

    lines.push('');
    lines.push('Último evento válido recebido:');
    lines.push(`Tipo: ${status.latestEvent.event_type}`);
    lines.push(`Recebido em: ${toDiscordTimestamp(status.latestEvent.received_at_ms)}`);

    if (status.latestEvent.event_type === 'channel.followed' && status.latestFollow) {
      lines.push(`Follower: ${status.latestFollow.follower_username}`);
      lines.push(`Kick user ID: ${status.latestFollow.follower_user_id}`);
    }

    await interaction.reply({
      content: lines.join('\n'),
      ephemeral: true,
    });
  },
};
