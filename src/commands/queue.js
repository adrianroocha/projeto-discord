const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fila')
    .setDescription('Exibe os botões para entrar ou sair da fila.'),
  async execute(interaction) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('join_queue')
        .setLabel('🎮 Entrar na fila')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('leave_queue')
        .setLabel('❌ Sair da fila')
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({
      content: 'Use os botões abaixo para gerenciar sua posição na fila.',
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  },
};
