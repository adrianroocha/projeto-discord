const { SlashCommandBuilder } = require('discord.js');
const queueService = require('../services/queueService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fila-add-teste')
    .setDescription('Adiciona um usuário de teste à fila (uso apenas para desenvolvimento).')
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
        content: `✅ Usuário ${targetUser.tag} adicionado à fila${isSubscriber ? ' como SUB' : ''}.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `⚠️ Não foi possível adicionar ${targetUser.tag} à fila. Talvez ele já esteja na fila.`,
      ephemeral: true,
    });
  },
};
