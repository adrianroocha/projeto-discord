const config = require('../config');
const kickAccountsRepository = require('../database/kickAccountsRepository');
const subscriberEligibilityService = require('./subscriberEligibilityService');

function toDiscordFullTimestamp(linkedAtMs) {
  const unixSeconds = Math.floor(Number(linkedAtMs) / 1000);
  if (!Number.isFinite(unixSeconds)) {
    return 'Data indisponível';
  }
  return `<t:${unixSeconds}:F>`;
}

function formatOptionalTimestamp(ms) {
  if (ms === null || ms === undefined) {
    return 'indisponível';
  }

  return toDiscordFullTimestamp(ms);
}

function mapKickSubscriptionType(type) {
  if (type === 'direct') {
    return 'direta';
  }

  if (type === 'gifted') {
    return 'presenteada';
  }

  return 'indisponível';
}

function mapKickStatus(source) {
  if (!source.linked) {
    return 'indisponível';
  }

  if (source.active) {
    return 'ativa';
  }

  if (source.observed) {
    return 'inativa';
  }

  return 'ainda não observada por webhook';
}

async function fetchGuildMember(guild, discordId) {
  if (!guild || !guild.members || typeof guild.members.fetch !== 'function') {
    return null;
  }

  try {
    return await guild.members.fetch(discordId);
  } catch {
    return null;
  }
}

async function buildSubRoleDiagnostics(guild, discordId, prefetchedMember) {
  const member = prefetchedMember || (await fetchGuildMember(guild, discordId));
  if (!member) {
    return {
      subRoleStatus: 'indisponível',
      manageabilityStatus: 'indisponível',
    };
  }

  const subscriberRoleId = typeof config.subscriberRoleId === 'string' ? config.subscriberRoleId.trim() : '';
  const hasSubRole =
    Boolean(subscriberRoleId) &&
    Boolean(member.roles?.cache?.has && member.roles.cache.has(subscriberRoleId));

  return {
    subRoleStatus: subscriberRoleId ? (hasSubRole ? 'presente' : 'ausente') : 'indisponível',
    manageabilityStatus: member.manageable ? 'gerenciável' : 'não gerenciável',
  };
}

async function readLocalKickStatus(input) {
  const discordId = typeof input?.discordId === 'string' ? input.discordId.trim() : '';
  if (!discordId) {
    throw new Error('discordId inválido para consulta de status Kick.');
  }

  const eligibility = subscriberEligibilityService.getEligibility(discordId);
  const kickSource = eligibility.sources.kick;
  const manualSource = eligibility.sources.manual;
  const linkedAccount = kickSource.linked ? kickAccountsRepository.findByDiscordId(discordId) : null;

  const diagnostics = await buildSubRoleDiagnostics(
    input?.guild || null,
    discordId,
    input?.prefetchedMember || null,
  );

  const activeSources = [];
  if (kickSource.active) {
    activeSources.push('- Kick');
  }
  if (manualSource.active) {
    activeSources.push('- Concessão manual');
  }

  return {
    discordId,
    eligibility,
    kickSource,
    manualSource,
    linkedAtMs: linkedAccount?.linked_at_ms ?? null,
    activeSources,
    diagnostics,
  };
}

function formatKickStatusContent(status, options = {}) {
  const includeUserLine = options.includeUserLine !== false;
  const includeKickId = options.includeKickId !== false;
  const includeLinkGuidance = options.includeLinkGuidance === true;

  const lines = [];

  if (includeUserLine) {
    lines.push(`Usuário consultado: <@${status.discordId}>`);
  }

  lines.push(`Conta Kick vinculada: ${status.kickSource.linked ? 'sim' : 'não'}`);
  lines.push(`Conta Kick: ${status.kickSource.linked ? status.kickSource.kickUsername : 'não vinculada'}`);

  if (includeKickId) {
    lines.push(`Kick ID: ${status.kickSource.linked ? status.kickSource.kickUserId : 'indisponível'}`);
  }

  lines.push(`Vinculada em: ${formatOptionalTimestamp(status.linkedAtMs)}`);
  lines.push(`Assinatura Kick: ${mapKickStatus(status.kickSource)}`);
  lines.push(
    `Tipo Kick: ${status.kickSource.observed ? mapKickSubscriptionType(status.kickSource.subscriptionType) : 'indisponível'}`,
  );
  lines.push(`Início Kick: ${formatOptionalTimestamp(status.kickSource.startedAtMs)}`);
  lines.push(`Vencimento Kick: ${formatOptionalTimestamp(status.kickSource.expiresAtMs)}`);
  lines.push(`Concessão manual: ${status.manualSource.active ? 'ativa' : 'inativa'}`);
  lines.push(`Motivo manual: ${status.manualSource.active ? status.manualSource.reason : 'indisponível'}`);
  lines.push(
    `Vencimento manual: ${status.manualSource.active ? formatOptionalTimestamp(status.manualSource.expiresAtMs) : 'indisponível'}`,
  );
  lines.push(`Elegibilidade: ${status.eligibility.eligible ? 'ativa' : 'inativa'}`);
  lines.push('Fontes ativas:');
  lines.push(status.activeSources.length > 0 ? status.activeSources.join('\n') : '- nenhuma');
  lines.push(`Cargo SUB: ${status.diagnostics.subRoleStatus}`);
  lines.push(`Membro gerenciável pelo bot: ${status.diagnostics.manageabilityStatus}`);
  lines.push('Cargo SUB: sincronizado por gatilhos automáticos e reconciliação periódica.');
  lines.push('Prioridade da fila: definida por snapshot na primeira entrada do usuário em cada ciclo.');

  if (includeLinkGuidance && !status.kickSource.linked) {
    lines.push('');
    lines.push('Para vincular sua conta, use o botão "Vincular conta Kick" neste painel.');
  }

  return lines.join('\n');
}

module.exports = {
  readLocalKickStatus,
  formatKickStatusContent,
  _internal: {
    toDiscordFullTimestamp,
    formatOptionalTimestamp,
    mapKickSubscriptionType,
    mapKickStatus,
    fetchGuildMember,
    buildSubRoleDiagnostics,
  },
};
