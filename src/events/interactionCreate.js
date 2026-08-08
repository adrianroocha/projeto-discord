const joinQueueButton = require('../buttons/joinQueue');
const leaveQueueButton = require('../buttons/leaveQueue');
const kickLinkStartButton = require('../buttons/kickLinkStart');
const kickUnlinkConfirmButton = require('../buttons/kickUnlinkConfirm');
const kickUnlinkCancelButton = require('../buttons/kickUnlinkCancel');

const buttonHandlers = {
  [joinQueueButton.customId]: joinQueueButton,
  [leaveQueueButton.customId]: leaveQueueButton,
  [kickLinkStartButton.customId]: kickLinkStartButton,
};

const prefixButtonHandlers = [kickUnlinkConfirmButton, kickUnlinkCancelButton];
const legacyDevelopmentCommands = new Set(['fila-add-teste', 'dev-fill-queue', 'dev-clear-test-data']);

function getButtonHandler(customId) {
  const exactHandler = buttonHandlers[customId];
  if (exactHandler) {
    return exactHandler;
  }

  return prefixButtonHandlers.find(
    (handler) =>
      typeof handler.customIdPrefix === 'string' && customId.startsWith(handler.customIdPrefix),
  );
}

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    if (interaction.isButton()) {
      const handler = getButtonHandler(interaction.customId);
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
    if (!command) {
      if (legacyDevelopmentCommands.has(interaction.commandName)) {
        await interaction.reply({
          content:
            'Ferramenta de desenvolvimento: este comando está indisponível neste ambiente.',
          ephemeral: true,
        });
      }
      return;
    }

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
