jest.mock('../src/services/manualSubGrantService', () => ({
  createGrant: jest.fn(),
  revokeGrant: jest.fn(),
  getStatus: jest.fn(),
  hasActiveGrant: jest.fn(),
}));

jest.mock('../src/services/subscriberEligibilityService', () => ({
  getEligibility: jest.fn(),
}));

jest.mock('../src/services/subscriberRoleAutoSyncService', () => ({
  syncAfterEligibilityChange: jest.fn(),
}));

jest.mock('../src/services/queueService', () => ({
  addToQueue: jest.fn(),
  removeFromQueue: jest.fn(),
  getQueue: jest.fn(),
}));

const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const service = require('../src/services/manualSubGrantService');
const eligibilityService = require('../src/services/subscriberEligibilityService');
const autoSyncService = require('../src/services/subscriberRoleAutoSyncService');
const queueService = require('../src/services/queueService');
const subGrantCommand = require('../src/commands/subGrant');
const subRevokeCommand = require('../src/commands/subRevoke');
const subStatusCommand = require('../src/commands/subStatus');

function makeAdminPermissions(isAdmin = true) {
  return {
    has: (flag) => isAdmin && flag === PermissionFlagsBits.Administrator,
  };
}

function makeBaseInteraction(overrides = {}) {
  return {
    inGuild: () => true,
    memberPermissions: makeAdminPermissions(true),
    user: { id: 'admin-1' },
    member: {
      roles: {
        add: jest.fn(),
        remove: jest.fn(),
      },
    },
    options: {
      getUser: jest.fn(),
      getString: jest.fn(),
      getInteger: jest.fn(),
    },
    reply: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('sub admin commands', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    autoSyncService.syncAfterEligibilityChange.mockResolvedValue({
      status: 'synced',
      eligibility: true,
      sources: { kick: false, manual: true },
      roleState: 'added',
    });
  });

  test('somente Administrator pode usar comandos', async () => {
    const interaction = makeBaseInteraction({
      memberPermissions: makeAdminPermissions(false),
      options: {
        getUser: jest.fn(),
        getString: jest.fn(),
        getInteger: jest.fn(),
      },
    });

    await subGrantCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(service.createGrant).not.toHaveBeenCalled();
  });

  test('recusa em DM', async () => {
    const interaction = makeBaseInteraction({ inGuild: () => false });

    await subGrantCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  test('respostas são ephemeral no /sub-grant', async () => {
    service.createGrant.mockReturnValue({
      created: true,
      grant: {
        discordId: 'user-1',
        reason: 'Pix recebido',
        grantedByDiscordId: 'admin-1',
        grantedAtMs: 1_000,
        expiresAtMs: null,
      },
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-1', bot: false }),
        getString: jest.fn().mockReturnValue('Pix recebido'),
        getInteger: jest.fn().mockReturnValue(null),
      },
    });

    await subGrantCommand.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  test('usuário bot é rejeitado no /sub-grant', async () => {
    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'bot-1', bot: true }),
        getString: jest.fn().mockReturnValue('Cortesia'),
        getInteger: jest.fn().mockReturnValue(null),
      },
    });

    await subGrantCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não é possível conceder benefício manual para bots.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('grant permanente', async () => {
    service.createGrant.mockReturnValue({
      created: true,
      grant: {
        discordId: 'user-2',
        reason: 'Cortesia',
        grantedByDiscordId: 'admin-1',
        grantedAtMs: 2_000,
        expiresAtMs: null,
      },
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-2', bot: false }),
        getString: jest.fn().mockReturnValue('Cortesia'),
        getInteger: jest.fn().mockReturnValue(null),
      },
    });

    await subGrantCommand.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Vencimento: sem vencimento');
    expect(payload.content).toContain('Estado do cargo SUB: adicionado');
    expect(payload.content).toContain('Elegibilidade final: ativa');
    expect(payload.content).not.toContain('Prioridade na fila:');
  });

  test('grant temporário', async () => {
    service.createGrant.mockReturnValue({
      created: true,
      grant: {
        discordId: 'user-3',
        reason: 'Pix',
        grantedByDiscordId: 'admin-1',
        grantedAtMs: 3_000,
        expiresAtMs: 3_000 + 30 * 24 * 60 * 60 * 1000,
      },
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-3', bot: false }),
        getString: jest.fn().mockReturnValue('Pix'),
        getInteger: jest.fn().mockReturnValue(30),
      },
    });

    await subGrantCommand.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Vencimento: <t:');
    expect(autoSyncService.syncAfterEligibilityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'user-3',
        triggerType: 'manual_grant',
      }),
    );
  });

  test('grant permanece salvo quando sync falha', async () => {
    service.createGrant.mockReturnValue({
      created: true,
      grant: {
        discordId: 'user-3b',
        reason: 'Pix',
        grantedByDiscordId: 'admin-1',
        grantedAtMs: 3_100,
        expiresAtMs: null,
      },
    });
    autoSyncService.syncAfterEligibilityChange.mockResolvedValue({
      status: 'warning',
      eligibility: null,
      sources: { kick: false, manual: false },
      roleState: 'pending',
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-3b', bot: false }),
        getString: jest.fn().mockReturnValue('Pix'),
        getInteger: jest.fn().mockReturnValue(null),
      },
    });

    await subGrantCommand.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Concessão manual registrada com sucesso.');
    expect(payload.content).toContain('sincronização automática do cargo ficou pendente');
    expect(payload.content).not.toContain('benefícios');
  });

  test('grant com cargo já presente informa estado mantido', async () => {
    service.createGrant.mockReturnValue({
      created: true,
      grant: {
        discordId: 'user-3c',
        reason: 'Pix',
        grantedByDiscordId: 'admin-1',
        grantedAtMs: 3_200,
        expiresAtMs: null,
      },
    });
    autoSyncService.syncAfterEligibilityChange.mockResolvedValue({
      status: 'synced',
      eligibility: true,
      sources: { kick: false, manual: true },
      roleState: 'kept',
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-3c', bot: false }),
        getString: jest.fn().mockReturnValue('Pix'),
        getInteger: jest.fn().mockReturnValue(null),
      },
    });

    await subGrantCommand.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Estado do cargo SUB: mantido');
  });

  test('grant duplicado ativo', async () => {
    service.createGrant.mockReturnValue({ created: false, reason: 'active_exists' });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-4', bot: false }),
        getString: jest.fn().mockReturnValue('Pix'),
        getInteger: jest.fn().mockReturnValue(30),
      },
    });

    await subGrantCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Já existe uma concessão manual ativa para este usuário.',
      }),
    );
  });

  test('revoke ativo', async () => {
    service.revokeGrant.mockReturnValue({
      revoked: true,
      grant: {
        discordId: 'user-5',
        revokedByDiscordId: 'admin-1',
        revokedAtMs: 5_000,
        revokeReason: 'Encerrado',
      },
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-5', bot: false }),
        getString: jest.fn().mockReturnValue('Encerrado'),
        getInteger: jest.fn(),
      },
    });

    await subRevokeCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Concessão manual revogada.');
    expect(payload.content).toContain('Fontes ativas:');
    expect(autoSyncService.syncAfterEligibilityChange).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'user-5',
        triggerType: 'manual_revoke',
      }),
    );
  });

  test('revoke mantém cargo quando fonte Kick segue ativa', async () => {
    service.revokeGrant.mockReturnValue({
      revoked: true,
      grant: {
        discordId: 'user-5b',
        revokedByDiscordId: 'admin-1',
        revokedAtMs: 5_100,
        revokeReason: 'Encerrado',
      },
    });
    autoSyncService.syncAfterEligibilityChange.mockResolvedValue({
      status: 'synced',
      eligibility: true,
      sources: { kick: true, manual: false },
      roleState: 'kept',
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-5b', bot: false }),
        getString: jest.fn().mockReturnValue('Encerrado'),
        getInteger: jest.fn(),
      },
    });

    await subRevokeCommand.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Fontes ativas:\n- Kick');
    expect(payload.content).toContain('Estado do cargo SUB: mantido');
    expect(payload.content).not.toContain('Prioridade na fila:');
  });

  test('revoke permanece salvo quando sync falha', async () => {
    service.revokeGrant.mockReturnValue({
      revoked: true,
      grant: {
        discordId: 'user-5c',
        revokedByDiscordId: 'admin-1',
        revokedAtMs: 5_200,
        revokeReason: 'Encerrado',
      },
    });
    autoSyncService.syncAfterEligibilityChange.mockResolvedValue({
      status: 'warning',
      eligibility: null,
      sources: { kick: false, manual: false },
      roleState: 'pending',
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-5c', bot: false }),
        getString: jest.fn().mockReturnValue('Encerrado'),
        getInteger: jest.fn(),
      },
    });

    await subRevokeCommand.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Concessão manual revogada.');
    expect(payload.content).toContain('sincronização automática do cargo ficou pendente');
  });

  test('revoke remove cargo quando não há fontes ativas', async () => {
    service.revokeGrant.mockReturnValue({
      revoked: true,
      grant: {
        discordId: 'user-5d',
        revokedByDiscordId: 'admin-1',
        revokedAtMs: 5_300,
        revokeReason: 'Encerrado',
      },
    });
    autoSyncService.syncAfterEligibilityChange.mockResolvedValue({
      status: 'synced',
      eligibility: false,
      sources: { kick: false, manual: false },
      roleState: 'removed',
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-5d', bot: false }),
        getString: jest.fn().mockReturnValue('Encerrado'),
        getInteger: jest.fn(),
      },
    });

    await subRevokeCommand.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Fontes ativas:\n- nenhuma');
    expect(payload.content).toContain('Estado do cargo SUB: removido');
  });

  test('revoke inexistente', async () => {
    service.revokeGrant.mockReturnValue({ revoked: false, reason: 'not_found' });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-6', bot: false }),
        getString: jest.fn().mockReturnValue('Sem ativo'),
        getInteger: jest.fn(),
      },
    });

    await subRevokeCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não há concessão manual ativa para este usuário no momento.',
      }),
    );
  });

  test('status ativo', async () => {
    eligibilityService.getEligibility.mockReturnValue({
      eligible: true,
      sources: {
        kick: {
          linked: true,
          active: true,
          observed: true,
          kickUserId: 'kick-user-7',
          kickUsername: 'kick7',
          startedAtMs: 5_000,
          expiresAtMs: 20_000,
          subscriptionType: 'direct',
        },
        manual: {
          active: true,
          reason: 'Pix',
          grantedByDiscordId: 'admin-1',
          grantedAtMs: 10_000,
          expiresAtMs: null,
        },
      },
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-7', bot: false }),
        getString: jest.fn(),
        getInteger: jest.fn(),
      },
    });

    await subStatusCommand.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Concessão manual: ativa');
    expect(payload.content).toContain('Assinatura Kick: ativa');
    expect(payload.content).toContain('Tipo Kick: direta');
    expect(payload.content).toContain('Elegibilidade: ativa');
    expect(payload.content).toContain('Fontes ativas:\n- Kick\n- Concessão manual');
    expect(payload.content).toContain('Cargo: diagnóstico via /sub-sync');
  });

  test('status manual-only não afirma subscriber Kick', async () => {
    eligibilityService.getEligibility.mockReturnValue({
      eligible: true,
      sources: {
        kick: {
          linked: true,
          active: false,
          observed: false,
          kickUserId: 'kick-user-8',
          kickUsername: 'kick8',
          startedAtMs: null,
          expiresAtMs: null,
          subscriptionType: null,
        },
        manual: {
          active: true,
          reason: 'Cortesia',
          grantedByDiscordId: 'admin-1',
          grantedAtMs: 10_000,
          expiresAtMs: 12_000,
        },
      },
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-8', bot: false }),
        getString: jest.fn(),
        getInteger: jest.fn(),
      },
    });

    await subStatusCommand.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Assinatura Kick: ainda não observada por webhook');
    expect(payload.content).toContain('Concessão manual: ativa');
    expect(payload.content).toContain('Elegibilidade: ativa');
    expect(payload.content).toContain('Fontes ativas:\n- Concessão manual');
  });

  test('status inativo sem fontes ativas', async () => {
    eligibilityService.getEligibility.mockReturnValue({
      eligible: false,
      sources: {
        kick: {
          linked: false,
          active: false,
          observed: false,
          kickUserId: null,
          kickUsername: null,
          startedAtMs: null,
          expiresAtMs: null,
          subscriptionType: null,
        },
        manual: {
          active: false,
          reason: null,
          grantedByDiscordId: null,
          grantedAtMs: null,
          expiresAtMs: null,
        },
      },
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-9', bot: false }),
        getString: jest.fn(),
        getInteger: jest.fn(),
      },
    });

    await subStatusCommand.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Conta Kick: não vinculada');
    expect(payload.content).toContain('Concessão manual: inativa');
    expect(payload.content).toContain('Elegibilidade: inativa');
    expect(payload.content).toContain('Fontes ativas:\n- nenhuma');
  });

  test('não altera cargo e não altera fila nesta etapa', async () => {
    service.createGrant.mockReturnValue({
      created: true,
      grant: {
        discordId: 'user-10',
        reason: 'Pix',
        grantedByDiscordId: 'admin-1',
        grantedAtMs: 10_000,
        expiresAtMs: null,
      },
    });

    const interaction = makeBaseInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'user-10', bot: false }),
        getString: jest.fn().mockReturnValue('Pix'),
        getInteger: jest.fn().mockReturnValue(null),
      },
    });

    await subGrantCommand.execute(interaction);

    expect(interaction.member.roles.add).not.toHaveBeenCalled();
    expect(interaction.member.roles.remove).not.toHaveBeenCalled();
    expect(queueService.addToQueue).not.toHaveBeenCalled();
    expect(queueService.removeFromQueue).not.toHaveBeenCalled();
    expect(queueService.getQueue).not.toHaveBeenCalled();
  });
});
