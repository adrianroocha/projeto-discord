const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const queueService = require('../services/queueService');
const queueMessageService = require('../services/queueMessageService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lobby-form-force')
    .setDescription('Cria manualmente uma lobby em formação com a quantidade solicitada de jogadores.')
    .addIntegerOption((option) =>
      option
        .setName('quantidade')
        .setDescription('Quantidade de jogadores para preencher a lobby (1-4)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(4),
    ),

  async execute(interaction) {
    const member = interaction.member;
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && !member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        content: 'Você precisa ser Administrador ou ter permissão de Gerenciar Servidor para usar este comando.',
        ephemeral: true,
      });
      return;
    }

    const quantidade = interaction.options.getInteger('quantidade');
    const result = queueService.forceCreateLobby(quantidade);
    if (!result || result.success === false) {
      const available = result ? result.available : 0;
      await interaction.reply({
        content: `❌ Não há jogadores suficientes na fila. Jogadores disponíveis: ${available}.`,
        ephemeral: true,
      });
      return;
    }

    const entries = result.entries;
    const lines = entries.map((entry, index) => {
      const position = index + 1;
      const name = entry.display_name?.trim() ? entry.display_name : entry.username;
      return `${position}. ${name}`;
    });

    await queueMessageService.updatePanel(interaction.client);

    await interaction.reply({
      content: `✅ Lobby criada com sucesso.\n\nJogadores:\n${lines.join('\n')}`,
      ephemeral: true,
    });
  },
};
