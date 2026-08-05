const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function formatUptime(uptimeMs) {
  const totalSeconds = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours}h ${minutes}m ${seconds}s`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Mostra informações de diagnóstico do bot.'),
  async execute(interaction) {
    const { client } = interaction;

    const uptime = client.uptime || 0;
    const startedAt = client.readyTimestamp ? new Date(client.readyTimestamp) : new Date();

    const embed = new EmbedBuilder()
      .setTitle('Status do Bot')
      .setColor(0x0099ff)
      .addFields(
        { name: 'Nome do bot', value: client.user?.username || 'Desconhecido', inline: true },
        { name: 'ID do bot', value: client.user?.id || 'Desconhecido', inline: true },
        { name: 'Servidores conectados', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'Usuários em cache', value: `${client.users.cache.size}`, inline: true },
        { name: 'Tempo online', value: formatUptime(uptime), inline: true },
        {
          name: 'Inicializado em',
          value: `<t:${Math.floor(startedAt.getTime() / 1000)}:F>`,
          inline: false,
        },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
