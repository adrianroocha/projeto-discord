const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const queueService = require('../services/queueService');
const queueMessageService = require('../services/queueMessageService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lobby-start')
    .setDescription('Inicia um lobby em formação.')
    .addIntegerOption((option) =>
      option
        .setName('numero')
        .setDescription('Número público da lobby para iniciar')
        .setRequired(false),
    ),
  async execute(interaction) {
    const member = interaction.member;
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        content: 'Você precisa de permissão de Gerenciar Servidor para executar este comando.',
        ephemeral: true,
      });
      return;
    }

    const formingLobbies = queueService.getActiveLobbies('forming');
    if (!formingLobbies.length) {
      await interaction.reply({
        content: 'Não há lobbies em formação no momento.',
        ephemeral: true,
      });
      return;
    }

    const lobbyNumberOption = interaction.options.getInteger('numero');
    let lobbyNumber = lobbyNumberOption;

    if (!lobbyNumber) {
      if (formingLobbies.length === 1) {
        lobbyNumber = formingLobbies[0].lobbyNumber;
      } else {
        const lobbyList = formingLobbies.map((lobby) => `• Lobby #${lobby.lobbyNumber}`).join('\n');
        await interaction.reply({
          content: `Lobbies em formação:\n${lobbyList}\n\nUse /lobby-start numero:<NÚMERO> para iniciar uma lobby.`,
          ephemeral: true,
        });
        return;
      }
    }

    const started = queueService.startLobbyByNumber(lobbyNumber);
    if (!started) {
      await interaction.reply({
        content: 'Não foi possível iniciar essa lobby. Verifique se ela ainda está em formação.',
        ephemeral: true,
      });
      return;
    }

    await queueMessageService.updatePanel(interaction.client);

    await interaction.reply({
      content: `Lobby #${lobbyNumber} iniciada com sucesso.`,
      ephemeral: true,
    });
  },
};
