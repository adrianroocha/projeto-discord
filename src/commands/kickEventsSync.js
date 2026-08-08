const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const kickEventSubscriptionService = require('../services/kickEventSubscriptionService');

function renderCreated(created) {
  if (!Array.isArray(created) || created.length === 0) {
    return '- nenhuma';
  }

  return created.map((event) => `- ${event}`).join('\n');
}

function renderAlreadyActive(alreadyActive) {
  if (!Array.isArray(alreadyActive) || alreadyActive.length === 0) {
    return '- nenhuma';
  }

  return alreadyActive.map((event) => `- ${event}`).join('\n');
}

function renderFailures(failed) {
  if (!Array.isArray(failed) || failed.length === 0) {
    return '- nenhuma';
  }

  return failed.map((item) => `- ${item.event} (${item.reason})`).join('\n');
}

function mapErrorToUserMessage(error) {
  if (typeof error?.upstreamMessage === 'string' && error.upstreamMessage.trim()) {
    return `Kick API retornou: ${error.upstreamMessage.trim()}`;
  }

  if (error?.code === 'MISSING_CONFIG' && error.missingVar) {
    return `Configuração incompleta: variável obrigatória ausente ${error.missingVar}.`;
  }

  if (error?.code === 'INVALID_BROADCASTER_ID') {
    return 'Configuração inválida: KICK_BROADCASTER_USER_ID deve ser um inteiro positivo.';
  }

  if (error?.code === 'RATE_LIMITED') {
    return 'A Kick aplicou rate limit (429). Tente novamente em instantes.';
  }

  if (error?.code === 'REQUEST_TIMEOUT') {
    return 'A requisição para a Kick expirou por tempo limite. Tente novamente.';
  }

  if (error?.code === 'UNAUTHORIZED' || error?.code === 'FORBIDDEN') {
    return 'A Kick recusou a autenticação/autorização da aplicação para sincronizar eventos.';
  }

  if (error?.code === 'BAD_REQUEST') {
    return 'A Kick rejeitou a requisição de sincronização de eventos (400). Revise as configurações da aplicação.';
  }

  if (error?.code === 'UPSTREAM_UNAVAILABLE') {
    return 'A API da Kick está indisponível no momento. Tente novamente mais tarde.';
  }

  return 'Não foi possível sincronizar os eventos da Kick no momento.';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick-events-sync')
    .setDescription('Sincroniza os event subscriptions oficiais da Kick para a aplicação.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: 'Você precisa da permissão de Administrator para usar este comando.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await kickEventSubscriptionService.syncDesiredEvents();

      const message = [
        'Sincronização dos eventos Kick concluída.',
        '',
        'Criados:',
        result.created.length > 0 ? renderCreated(result.created) : '- nenhuma',
        '',
        'Já ativos:',
        renderAlreadyActive(result.alreadyActive),
        '',
        'Falhas:',
        renderFailures(result.failed),
      ].join('\n');

      await interaction.editReply(message);
    } catch (error) {
      await interaction.editReply(mapErrorToUserMessage(error));
    }
  },
};
