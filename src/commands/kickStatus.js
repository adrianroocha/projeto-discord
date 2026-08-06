const { SlashCommandBuilder } = require('discord.js');
const kickAccountsRepository = require('../database/kickAccountsRepository');

function toDiscordFullTimestamp(linkedAtMs) {
  const unixSeconds = Math.floor(Number(linkedAtMs) / 1000);
  if (!Number.isFinite(unixSeconds)) {
    return 'Data indisponível';
  }
  return `<t:${unixSeconds}:F>`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick-status')
    .setDescription('Mostra o estado do vínculo da sua conta da Kick.'),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        ephemeral: true,
      });
      return;
    }

    const link = kickAccountsRepository.findByDiscordId(interaction.user.id);
    if (!link) {
      await interaction.reply({
        content: 'Nenhuma conta Kick está vinculada. Use /kick-link para vincular sua conta.',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: [
        `Conta Kick: ${link.kick_username}`,
        `Kick ID: ${link.kick_user_id}`,
        `Vinculada em: ${toDiscordFullTimestamp(link.linked_at_ms)}`,
        'Status da assinatura: ainda não sincronizado',
      ].join('\n'),
      ephemeral: true,
    });
  },
};
