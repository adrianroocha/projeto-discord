const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const livepixAuthService = require('../services/livepixAuthService');

const subscriptionStatuses = new Set(['active', 'pending', 'cancelled']);
const subscriptionStatusLabels = {
  active: 'ativas',
  pending: 'pendentes',
  cancelled: 'canceladas',
};

function invalidResponse(code) {
  return Object.assign(new Error('Invalid LivePix response.'), { code });
}

function validateSubscriptions(subscriptions) {
  if (
    !Array.isArray(subscriptions) ||
    subscriptions.some(
      (subscription) =>
        !subscription ||
        typeof subscription !== 'object' ||
        Array.isArray(subscription) ||
        typeof subscription.id !== 'string' ||
        !subscription.id ||
        typeof subscription.status !== 'string' ||
        !subscriptionStatuses.has(subscription.status.toLowerCase()),
    )
  ) {
    throw invalidResponse('COMMAND_INVALID_SUBSCRIPTIONS_RESPONSE');
  }

  return subscriptions;
}

function validatePlans(plans) {
  if (
    !Array.isArray(plans) ||
    plans.some(
      (plan) =>
        !plan ||
        typeof plan !== 'object' ||
        Array.isArray(plan) ||
        typeof plan.id !== 'string' ||
        !plan.id ||
        typeof plan.name !== 'string' ||
        !plan.name,
    )
  ) {
    throw invalidResponse('COMMAND_INVALID_SUBSCRIPTION_PLANS_RESPONSE');
  }

  return plans;
}

function describeError(error, context) {
  switch (error?.code) {
    case 'UNAUTHORIZED':
      return context === 'authentication'
        ? 'HTTP 401: autenticação LivePix recusada.'
        : 'HTTP 401: token inválido/expirado ou escopo não autorizado.';
    case 'FORBIDDEN':
      return 'HTTP 403: acesso proibido pela LivePix.';
    case 'RATE_LIMITED':
      return 'HTTP 429: limite de requisições atingido.';
    case 'REQUEST_TIMEOUT':
      return 'Tempo limite excedido ao consultar a LivePix.';
    case 'NETWORK_ERROR':
      return 'Falha de rede ao consultar a LivePix.';
    case 'INVALID_SUBSCRIPTIONS_RESPONSE':
      return 'O serviço LivePix rejeitou a resposta de assinaturas.';
    case 'COMMAND_INVALID_SUBSCRIPTIONS_RESPONSE':
      return 'A validação adicional do comando rejeitou a resposta de assinaturas.';
    case 'INVALID_SUBSCRIPTION_PLANS_RESPONSE':
      return 'O serviço LivePix rejeitou a resposta de planos.';
    case 'COMMAND_INVALID_SUBSCRIPTION_PLANS_RESPONSE':
      return 'A validação adicional do comando rejeitou a resposta de planos.';
    case 'INVALID_JSON_RESPONSE':
      return 'O serviço LivePix retornou JSON inválido.';
    case 'INVALID_TOKEN_RESPONSE':
      return 'O serviço LivePix retornou uma resposta OAuth inválida.';
    case 'MISSING_CONFIG':
      return 'Configuração necessária da LivePix ausente.';
    case 'BAD_REQUEST':
      return 'A LivePix rejeitou os parâmetros da consulta.';
    case 'NOT_FOUND':
      return 'Recurso não encontrado na LivePix.';
    case 'UPSTREAM_UNAVAILABLE':
    case 'UPSTREAM_ERROR':
      return 'A API LivePix está indisponível ou rejeitou a consulta.';
    default:
      return 'Falha inesperada na consulta LivePix.';
  }
}

function formatEndpointResult(label, result) {
  if (result.status === 'rejected') {
    const resetMessage =
      result.reason?.code === 'RATE_LIMITED' &&
      Number.isSafeInteger(result.reason.cooldownUntil) &&
      result.reason.cooldownUntil > Date.now()
        ? ` Consulta disponível após <t:${Math.floor(result.reason.cooldownUntil / 1000)}:F>.`
        : '';
    return `**${label}:** ❌ Falha — ${describeError(result.reason, 'query')}${resetMessage}`;
  }

  const itemLabel = result.value.length === 1 ? 'item' : 'itens';
  return `**${label}:** ✅ ${result.value.length} ${itemLabel} na página`;
}

function queryEndpoint(endpoint, query, validate) {
  const cooldownUntil = livepixAuthService.getEndpointCooldown(endpoint);
  if (cooldownUntil) {
    return Promise.reject(
      Object.assign(new Error('LivePix endpoint is cooling down.'), {
        code: 'RATE_LIMITED',
        cooldownUntil,
      }),
    );
  }
  return query().then(validate);
}

function formatStatusCounts(subscriptions) {
  const counts = { active: 0, pending: 0, cancelled: 0 };
  for (const subscription of subscriptions) {
    counts[subscription.status.toLowerCase()] += 1;
  }

  return `**Status nesta página:** ${Object.entries(counts)
    .map(([status, count]) => `${subscriptionStatusLabels[status]} ${count}`)
    .join(' · ')}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('livepix-consultas')
    .setDescription('Valida consultas de assinaturas e planos LivePix.')
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
      const accessToken = await livepixAuthService.getAccessToken();
      if (typeof accessToken !== 'string' || !accessToken.trim()) {
        throw invalidResponse('INVALID_TOKEN_RESPONSE');
      }
    } catch (error) {
      const reason = describeError(error, 'authentication');
      await interaction.editReply({
        content: [
          '**Autenticação:** ❌ Falha — ' + reason,
          '**Assinaturas:** não consultadas devido à falha de autenticação.',
          '**Planos:** não consultados devido à falha de autenticação.',
        ].join('\n'),
        allowedMentions: { parse: [] },
      });
      return;
    }

    const [subscriptionsResult, plansResult] = await Promise.allSettled([
      queryEndpoint(
        '/v2/subscriptions',
        () => livepixAuthService.listSubscriptions({ page: 1, limit: 10 }),
        validateSubscriptions,
      ),
      queryEndpoint(
        '/v2/subscriptions/plans',
        () => livepixAuthService.listSubscriptionPlans({ page: 1, limit: 10 }),
        validatePlans,
      ),
    ]);

    const lines = [
      '**Autenticação:** ✅ Token obtido.',
      formatEndpointResult('Assinaturas', subscriptionsResult),
      formatEndpointResult('Planos', plansResult),
      '*As quantidades abrangem somente a primeira página (até 10 itens), não o total da conta.*',
    ];

    if (subscriptionsResult.status === 'fulfilled') {
      lines.splice(3, 0, formatStatusCounts(subscriptionsResult.value));
    }

    await interaction.editReply({
      content: lines.join('\n'),
      allowedMentions: { parse: [] },
    });
  },
};
