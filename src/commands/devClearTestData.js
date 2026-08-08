const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const queueService = require('../services/queueService');
const config = require('../config');

module.exports = {
  developmentOnly: true,
  data: new SlashCommandBuilder()
    .setName('dev-clear-test-data')
    .setDescription('Limpa dados de teste fictícios da fila e das lobbies (apenas em desenvolvimento).')
    .addBooleanOption((option) =>
      option
        .setName('confirmar')
        .setDescription('Confirma a remoção dos dados de teste.')
        .setRequired(true),
    ),

  async execute(interaction) {
    if (config.nodeEnv !== 'development') {
      await interaction.reply({
        content: 'Este comando está disponível apenas em ambiente de desenvolvimento.',
        ephemeral: true,
      });
      return;
    }

    const member = interaction.member;
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && !member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        content: 'Você precisa ser Administrador ou ter permissão de Gerenciar Servidor para usar este comando.',
        ephemeral: true,
      });
      return;
    }

    const confirmed = interaction.options.getBoolean('confirmar');
    if (!confirmed) {
      await interaction.reply({
        content: 'A limpeza de dados de teste foi cancelada.',
        ephemeral: true,
      });
      return;
    }

    try {
      queueService.clearTestData();
      await interaction.reply({
        content: '✅ Dados de teste removidos com sucesso.',
        ephemeral: true,
      });
    } catch (error) {
      console.error('Erro ao limpar dados de teste:', error);
      await interaction.reply({
        content: 'Houve um erro ao limpar os dados de teste.',
        ephemeral: true,
      });
    }
  },
};
