const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const queueService = require('../services/queueService');
const queueMessageService = require('../services/queueMessageService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lobby-start-force')
    .setDescription('Força a criação de um lobby com os jogadores que estão aguardando na fila.'),

  async execute(interaction) {
    const member = interaction.member;
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && !member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        content: 'Você precisa ser Administrador ou ter permissão de Gerenciar Servidor para usar este comando.',
        ephemeral: true,
      });
      return;
    }

    const entries = queueService.forceCreateLobby(4);
    if (!entries || !entries.length) {
      await interaction.reply({
        content: '❌ Não existem jogadores aguardando na fila.',
        ephemeral: true,
      });
      return;
    }

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
