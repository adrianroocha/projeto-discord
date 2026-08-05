const joinQueueButton = require('../buttons/joinQueue');
const leaveQueueButton = require('../buttons/leaveQueue');

const buttonHandlers = {
  [joinQueueButton.customId]: joinQueueButton,
  [leaveQueueButton.customId]: leaveQueueButton,
};

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    if (interaction.isButton()) {
      const handler = buttonHandlers[interaction.customId];
      if (!handler) return;

      try {
        await handler.execute(interaction);
      } catch (error) {
        console.error('Erro ao processar botão:', error);
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: 'Houve um erro ao processar esse botão.',
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: 'Houve um erro ao processar esse botão.',
            ephemeral: true,
          });
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error('Erro ao executar comando:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'Houve um erro ao executar esse comando.',
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: 'Houve um erro ao executar esse comando.',
          ephemeral: true,
        });
      }
    }
  },
};
