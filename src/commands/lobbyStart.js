const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const queueService = require('../services/queueService');
const queueMessageService = require('../services/queueMessageService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lobby-start')
    .setDescription('Inicia um lobby em formação.')
    .addIntegerOption((option) =>
      option
        .setName('lobby_id')
        .setDescription('ID do lobby para iniciar')
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

    const lobbyIdOption = interaction.options.getInteger('lobby_id');
    let lobbyId = lobbyIdOption;

    if (!lobbyId) {
      if (formingLobbies.length === 1) {
        lobbyId = formingLobbies[0].id;
      } else {
        const lobbyList = formingLobbies.map((lobby) => `• Lobby #${lobby.id}`).join('\n');
        await interaction.reply({
          content: `Lobbies em formação:\n${lobbyList}\n\nUse /lobby-start lobby_id:<ID> para iniciar um lobby.`,
          ephemeral: true,
        });
        return;
      }
    }

    const started = queueService.startLobby(lobbyId);
    if (!started) {
      await interaction.reply({
        content: 'Não foi possível iniciar esse lobby. Verifique se ele ainda está em formação.',
        ephemeral: true,
      });
      return;
    }

    await queueMessageService.updatePanel(interaction.client);

    await interaction.reply({
      content: `Lobby #${lobbyId} iniciado com sucesso.`,
      ephemeral: true,
    });
  },
};
