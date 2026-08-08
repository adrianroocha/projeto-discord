const { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const config = require('../config');
const queueService = require('../services/queueService');

module.exports = {
  developmentOnly: true,
  data: new SlashCommandBuilder()
    .setName('fila-add-teste')
    .setDescription('Adiciona um usuário de teste à fila (uso apenas para desenvolvimento).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild)
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Usuário a ser adicionado na fila')
        .setRequired(true),
    )
    .addBooleanOption((option) =>
      option
        .setName('subscriber')
        .setDescription('Indica se o usuário é subscriber')
        .setRequired(true),
    ),
  async execute(interaction) {
    if (config.nodeEnv !== 'development') {
      await interaction.reply({
        content:
          'Ferramenta de desenvolvimento: este comando está disponível somente em NODE_ENV=development.',
        ephemeral: true,
      });
      return;
    }

    const member = interaction.member;
    if (
      !member?.permissions?.has(PermissionsBitField.Flags.Administrator) &&
      !member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)
    ) {
      await interaction.reply({
        content:
          'Ferramenta de desenvolvimento: você precisa ser Administrator ou ter Manage Guild para usar este comando.',
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser('usuario');
    const targetMember = interaction.options.getMember('usuario');
    const displayName = targetMember?.displayName || targetUser.username;
    const isSubscriber = interaction.options.getBoolean('subscriber');

    const added = queueService.addToQueue({
      discordId: targetUser.id,
      username: `${targetUser.username}#${targetUser.discriminator}`,
      displayName,
      isSubscriber: isSubscriber ? 1 : 0,
    });

    if (added) {
      await interaction.reply({
        content: `✅ Ferramenta de desenvolvimento: usuário ${targetUser.tag} adicionado à fila${isSubscriber ? ' como SUB' : ''}.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `⚠️ Ferramenta de desenvolvimento: não foi possível adicionar ${targetUser.tag} à fila. Talvez ele já esteja na fila.`,
      ephemeral: true,
    });
  },
};
