const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const kickAuthService = require('../services/kickAuthService');
const kickAccountsRepository = require('../database/kickAccountsRepository');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick-link')
    .setDescription('Vincula sua conta da Kick ao seu usuário do Discord.'),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        ephemeral: true,
      });
      return;
    }

    if (!config.kickEnabled) {
      await interaction.reply({
        content: 'Integração com Kick está desativada neste ambiente.',
        ephemeral: true,
      });
      return;
    }

    const existingLink = kickAccountsRepository.findByDiscordId(interaction.user.id);
    if (existingLink) {
      await interaction.reply({
        content: `Sua conta já está vinculada: ${existingLink.kick_username} (Kick ID ${existingLink.kick_user_id}).`,
        ephemeral: true,
      });
      return;
    }

    const attempt = kickAuthService.createAuthorizationAttempt(interaction.user.id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Vincular conta Kick')
        .setURL(attempt.authorizationUrl),
    );

    await interaction.reply({
      content:
        'Clique no botão abaixo para autorizar a integração da Kick. O link expira em 10 minutos e solicita apenas o escopo user:read.',
      components: [row],
      ephemeral: true,
    });
  },
};
