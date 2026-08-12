const { createTestContext } = require('./helpers/testDatabase');

describe('kickStatusDiagnosticsService', () => {
  let context;
  let kickAccountsRepository;
  let kickSubscriptionsRepository;
  let manualSubGrantService;
  let service;

  function makeGuildMember(options = {}) {
    const hasSubRole = options.hasSubRole === true;
    return {
      manageable: options.manageable !== false,
      roles: {
        cache: {
          has: (roleId) => hasSubRole && roleId === 'sub-role-1',
        },
      },
    };
  }

  function makeGuild(options = {}) {
    return {
      members: {
        fetch: jest.fn(async () => {
          if (options.unavailable) {
            throw new Error('member fetch failed');
          }
          return makeGuildMember(options);
        }),
      },
    };
  }

  function upsertKickAccount(discordId, kickUserId, kickUsername, linkedAtMs = Date.now() - 1000) {
    return kickAccountsRepository.upsert({
      discordId,
      kickUserId,
      kickUsername,
      linkedAtMs,
      updatedAtMs: linkedAtMs,
    });
  }

  function upsertKickSubscription(input) {
    return kickSubscriptionsRepository.upsertFromEvent({
      broadcasterUserId: 'broadcaster-1',
      kickUserId: input.kickUserId,
      kickUsername: input.kickUsername,
      subscriptionType: input.subscriptionType,
      startedAtIso: input.startedAtIso,
      expiresAtIso: input.expiresAtIso,
      lastEventMessageId: input.lastEventMessageId || `evt-${input.kickUserId}`,
      updatedAtMs: input.updatedAtMs || Date.now(),
    });
  }

  beforeEach(async () => {
    context = await createTestContext({
      nodeEnv: 'test',
      subscriberRoleId: 'sub-role-1',
      kickBroadcasterUserId: 'broadcaster-1',
    });

    kickAccountsRepository = require('../src/database/kickAccountsRepository');
    kickSubscriptionsRepository = require('../src/database/kickSubscriptionsRepository');
    manualSubGrantService = require('../src/services/manualSubGrantService');
    service = require('../src/services/kickStatusDiagnosticsService');
  });

  afterEach(async () => {
    await context.cleanup();
  });

  test('usuário vinculado com assinatura ativa direta', async () => {
    upsertKickAccount('discord-direct', 'kick-direct', 'direct-user', 1_720_000_000_000);
    upsertKickSubscription({
      kickUserId: 'kick-direct',
      kickUsername: 'direct-user',
      subscriptionType: 'direct',
      startedAtIso: '2025-01-01T00:00:00.000Z',
      expiresAtIso: '2099-01-01T00:00:00.000Z',
    });

    const status = await service.readLocalKickStatus({
      discordId: 'discord-direct',
      guild: makeGuild({ hasSubRole: true }),
    });

    const content = service.formatKickStatusContent(status, { includeKickId: false });
    expect(content).toContain('Conta Kick vinculada: sim');
    expect(content).toContain('Assinatura Kick: ativa');
    expect(content).toContain('Tipo Kick: direta');
    expect(content).toContain('Cargo SUB: presente');
  });

  test('usuário vinculado com assinatura presenteada', async () => {
    upsertKickAccount('discord-gifted', 'kick-gifted', 'gifted-user');
    upsertKickSubscription({
      kickUserId: 'kick-gifted',
      kickUsername: 'gifted-user',
      subscriptionType: 'gifted',
      startedAtIso: '2025-01-01T00:00:00.000Z',
      expiresAtIso: '2099-01-01T00:00:00.000Z',
    });

    const status = await service.readLocalKickStatus({
      discordId: 'discord-gifted',
      guild: makeGuild({ hasSubRole: false, manageable: true }),
    });

    const content = service.formatKickStatusContent(status, { includeKickId: false });
    expect(content).toContain('Tipo Kick: presenteada');
    expect(content).toContain('Membro gerenciável pelo bot: gerenciável');
  });

  test('usuário vinculado ainda não observado por webhook', async () => {
    upsertKickAccount('discord-unobserved', 'kick-unobserved', 'unobserved-user');

    const status = await service.readLocalKickStatus({
      discordId: 'discord-unobserved',
      guild: makeGuild(),
    });

    const content = service.formatKickStatusContent(status, { includeKickId: false });
    expect(content).toContain('Assinatura Kick: ainda não observada por webhook');
    expect(content).toContain('Tipo Kick: indisponível');
  });

  test('usuário vinculado com assinatura inativa', async () => {
    upsertKickAccount('discord-inactive', 'kick-inactive', 'inactive-user');
    upsertKickSubscription({
      kickUserId: 'kick-inactive',
      kickUsername: 'inactive-user',
      subscriptionType: 'direct',
      startedAtIso: '2020-01-01T00:00:00.000Z',
      expiresAtIso: '2020-02-01T00:00:00.000Z',
    });

    const status = await service.readLocalKickStatus({
      discordId: 'discord-inactive',
      guild: makeGuild({ manageable: false }),
    });

    const content = service.formatKickStatusContent(status, { includeKickId: false });
    expect(content).toContain('Assinatura Kick: inativa');
    expect(content).toContain('Membro gerenciável pelo bot: não gerenciável');
  });

  test('concessão manual ativa sem vínculo mantém elegibilidade ativa', async () => {
    manualSubGrantService.createGrant({
      discordId: 'discord-manual-only',
      grantedByDiscordId: 'admin-1',
      reason: 'Cortesia',
      days: null,
      nowMs: Date.now() - 1000,
    });

    const status = await service.readLocalKickStatus({
      discordId: 'discord-manual-only',
      guild: makeGuild({ hasSubRole: false }),
    });

    const content = service.formatKickStatusContent(status, {
      includeUserLine: false,
      includeKickId: false,
      includeLinkGuidance: true,
    });

    expect(content).toContain('Conta Kick vinculada: não');
    expect(content).toContain('Concessão manual: ativa');
    expect(content).toContain('Elegibilidade: ativa');
    expect(content).toContain('Fontes ativas:\n- Concessão manual');
    expect(content).toContain('Para vincular sua conta, use o botão "Vincular conta Kick" neste painel.');
  });

  test('sem vínculo e sem benefício mantém elegibilidade inativa', async () => {
    const status = await service.readLocalKickStatus({
      discordId: 'discord-none',
      guild: makeGuild({ hasSubRole: false }),
    });

    const content = service.formatKickStatusContent(status, {
      includeUserLine: false,
      includeKickId: false,
      includeLinkGuidance: true,
    });

    expect(content).toContain('Conta Kick vinculada: não');
    expect(content).toContain('Concessão manual: inativa');
    expect(content).toContain('Elegibilidade: inativa');
    expect(content).toContain('Fontes ativas:\n- nenhuma');
  });

  test('datas conhecidas e desconhecidas são formatadas com fallback seguro', async () => {
    upsertKickAccount('discord-dates', 'kick-dates', 'dates-user', 1_700_000_000_000);

    const unobserved = await service.readLocalKickStatus({
      discordId: 'discord-dates',
      guild: makeGuild({ hasSubRole: false }),
    });

    const unobservedContent = service.formatKickStatusContent(unobserved, { includeKickId: false });
    expect(unobservedContent).toContain('Vinculada em: <t:1700000000:F>');
    expect(unobservedContent).toContain('Início Kick: indisponível');
    expect(unobservedContent).toContain('Vencimento Kick: indisponível');

    upsertKickSubscription({
      kickUserId: 'kick-dates',
      kickUsername: 'dates-user',
      subscriptionType: 'direct',
      startedAtIso: '2025-01-01T00:00:00.000Z',
      expiresAtIso: '2099-01-01T00:00:00.000Z',
      lastEventMessageId: 'evt-dates',
    });

    const observed = await service.readLocalKickStatus({
      discordId: 'discord-dates',
      guild: makeGuild({ hasSubRole: false }),
    });

    const observedContent = service.formatKickStatusContent(observed, { includeKickId: false });
    expect(observedContent).toContain('Início Kick: <t:1735689600:F>');
    expect(observedContent).toContain('Vencimento Kick: <t:4070908800:F>');
  });

  test('membro indisponível mantém leitura local e marca cargo/gerenciabilidade como indisponíveis', async () => {
    upsertKickAccount('discord-unavailable', 'kick-unavailable', 'unavailable-user');

    const status = await service.readLocalKickStatus({
      discordId: 'discord-unavailable',
      guild: makeGuild({ unavailable: true }),
    });

    const content = service.formatKickStatusContent(status, { includeKickId: false });
    expect(content).toContain('Conta Kick: unavailable-user');
    expect(content).toContain('Cargo SUB: indisponível');
    expect(content).toContain('Membro gerenciável pelo bot: indisponível');
  });

  test('resposta formatada não inclui dados sensíveis', async () => {
    const upsertSpy = jest.spyOn(kickAccountsRepository, 'upsert');
    const deleteSpy = jest.spyOn(kickAccountsRepository, 'deleteByDiscordId');
    const unlinkSpy = jest.spyOn(kickAccountsRepository, 'unlinkWithAudit');

    upsertKickAccount('discord-sensitive', 'kick-sensitive', 'sensitive-user');

    const status = await service.readLocalKickStatus({
      discordId: 'discord-sensitive',
      guild: makeGuild(),
    });

    const content = service.formatKickStatusContent(status, { includeKickId: false });
    expect(content).not.toContain('access_token');
    expect(content).not.toContain('refresh_token');
    expect(content).not.toContain('client_secret');
    expect(content).not.toContain('oauth_state');
    expect(content).not.toContain('stack');
    expect(content).not.toContain('C:/');
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });
});
