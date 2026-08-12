jest.mock('../src/services/manualSubGrantService', () => ({
  extendGrant: jest.fn(),
  constants: {
    MIN_DAYS: 1,
    MAX_DAYS: 365,
  },
}));

jest.mock('../src/services/subscriberRoleAutoSyncService', () => ({
  syncAfterEligibilityChange: jest.fn(),
}));

jest.mock('../src/services/adminCommandAuditService', () => ({
  beginRequired: jest.fn(),
  finishSuccess: jest.fn(),
  finishFailed: jest.fn(),
  finishDenied: jest.fn(),
  normalizeErrorCode: jest.fn((value, fallback) => value || fallback),
}));

const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const command = require('../src/commands/subGrantExtend');
const manualSubGrantService = require('../src/services/manualSubGrantService');
const subscriberRoleAutoSyncService = require('../src/services/subscriberRoleAutoSyncService');
const adminCommandAuditService = require('../src/services/adminCommandAuditService');

function makeMember({ isAdmin = true, isManageGuild = false, roleIds = [] } = {}) {
  return {
    permissions: {
      has: (flag) => {
        if (flag === PermissionFlagsBits.Administrator) {
          return isAdmin;
        }

        if (flag === PermissionFlagsBits.ManageGuild) {
          return isManageGuild;
        }

        return false;
      },
    },
    roles: {
      cache: {
        has: (roleId) => roleIds.includes(roleId),
      },
    },
  };
}

function makeInteraction(overrides = {}) {
  const actorMember = overrides.actorMember || makeMember({ isAdmin: true });

  return {
    id: 'interaction-1',
    commandName: 'sub-grant-extend',
    guildId: 'guild-1',
    channelId: 'channel-1',
    inGuild: () => true,
    guild: {
      members: {
        fetch: jest.fn().mockResolvedValue(actorMember),
      },
    },
    user: {
      id: 'admin-1',
      username: 'admin',
    },
    client: {},
    options: {
      getUser: jest.fn((name) => (name === 'usuario' ? { id: 'target-1', bot: false } : null)),
      getInteger: jest.fn((name) => (name === 'dias' ? 20 : null)),
      getString: jest.fn((name) => (name === 'motivo' ? 'Renovacao via PIX' : null)),
    },
    reply: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('/sub-grant-extend command', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    adminCommandAuditService.beginRequired.mockResolvedValue({ auditId: 11 });
    adminCommandAuditService.finishSuccess.mockResolvedValue({ auditSaved: true });
    adminCommandAuditService.finishFailed.mockResolvedValue({ auditSaved: true });
    adminCommandAuditService.finishDenied.mockResolvedValue({ auditSaved: true });

    manualSubGrantService.extendGrant.mockReturnValue({
      extended: true,
      statusBefore: 'active',
      previousExpiresAtMs: 1_000,
      newExpiresAtMs: 2_000,
    });

    subscriberRoleAutoSyncService.syncAfterEligibilityChange.mockResolvedValue({
      status: 'synced',
      roleState: 'kept',
    });
  });

  test('builder define nome, opções obrigatórias, limites e permissão de Administrator', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('sub-grant-extend');
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.Administrator));

    const userOption = json.options.find((option) => option.name === 'usuario');
    const daysOption = json.options.find((option) => option.name === 'dias');
    const reasonOption = json.options.find((option) => option.name === 'motivo');

    expect(userOption.required).toBe(true);
    expect(daysOption.required).toBe(true);
    expect(daysOption.min_value).toBe(1);
    expect(daysOption.max_value).toBe(365);
    expect(reasonOption.required).toBe(true);
    expect(reasonOption.min_length).toBe(3);
    expect(reasonOption.max_length).toBe(200);
  });

  test('sucesso com concessão ativa soma ao vencimento atual e responde ephemeral', async () => {
    manualSubGrantService.extendGrant.mockReturnValue({
      extended: true,
      statusBefore: 'active',
      previousExpiresAtMs: 1_000,
      newExpiresAtMs: 1_000 + 20 * 24 * 60 * 60 * 1000,
    });

    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(manualSubGrantService.extendGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        discordId: 'target-1',
        extendedByDiscordId: 'admin-1',
        days: 20,
        reason: 'Renovacao via PIX',
      }),
    );

    expect(adminCommandAuditService.finishSuccess).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        nextState: expect.objectContaining({
          targetDiscordId: 'target-1',
          daysAdded: 20,
          previousStatus: 'active',
        }),
      }),
    );

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('sucesso com concessão expirada reativa a partir de agora', async () => {
    manualSubGrantService.extendGrant.mockReturnValue({
      extended: true,
      statusBefore: 'expired',
      previousExpiresAtMs: 2_000,
      newExpiresAtMs: 3_000,
    });

    const interaction = makeInteraction();

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Estado anterior: expirada');
  });

  test('usuário comum é recusado e auditoria registra denied', async () => {
    const interaction = makeInteraction({
      actorMember: makeMember({ isAdmin: false }),
    });

    await command.execute(interaction);

    expect(manualSubGrantService.extendGrant).not.toHaveBeenCalled();
    expect(adminCommandAuditService.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MISSING_PERMISSION' }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Você precisa da permissão de Administrator para usar este comando.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(interaction.guild.members.fetch).toHaveBeenCalledWith('admin-1');
  });

  test('ator indisponível é recusado com MEMBER_UNAVAILABLE', async () => {
    const interaction = makeInteraction({
      guild: {
        members: {
          fetch: jest.fn().mockRejectedValue(new Error('not found')),
        },
      },
    });

    await command.execute(interaction);

    expect(adminCommandAuditService.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MEMBER_UNAVAILABLE' }),
    );
    expect(manualSubGrantService.extendGrant).not.toHaveBeenCalled();
  });

  test('usuário com apenas ManageGuild é recusado', async () => {
    const interaction = makeInteraction({
      actorMember: makeMember({ isAdmin: false, isManageGuild: true }),
    });

    await command.execute(interaction);

    expect(manualSubGrantService.extendGrant).not.toHaveBeenCalled();
    expect(adminCommandAuditService.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MISSING_PERMISSION' }),
    );
  });

  test('usuário com apenas BOT_OPERATOR_ROLE_IDS é recusado', async () => {
    const interaction = makeInteraction({
      actorMember: makeMember({ isAdmin: false, roleIds: ['900000000000000001'] }),
    });

    await command.execute(interaction);

    expect(manualSubGrantService.extendGrant).not.toHaveBeenCalled();
    expect(adminCommandAuditService.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MISSING_PERMISSION' }),
    );
  });

  test('decisão usa membro real do fetch e ignora payload memberPermissions', async () => {
    const interaction = makeInteraction({
      actorMember: makeMember({ isAdmin: false }),
      memberPermissions: {
        has: () => true,
      },
    });

    await command.execute(interaction);

    expect(interaction.guild.members.fetch).toHaveBeenCalledWith('admin-1');
    expect(manualSubGrantService.extendGrant).not.toHaveBeenCalled();
    expect(adminCommandAuditService.finishDenied).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MISSING_PERMISSION' }),
    );
  });

  test('input inválido falha com INVALID_INPUT e sem mutação', async () => {
    const interaction = makeInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'target-1', bot: false }),
        getInteger: jest.fn().mockReturnValue(0),
        getString: jest.fn().mockReturnValue('ok'),
      },
    });

    await command.execute(interaction);

    expect(manualSubGrantService.extendGrant).not.toHaveBeenCalled();
    expect(adminCommandAuditService.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'INVALID_INPUT' }),
    );
  });

  test('auditoria inicial indisponível bloqueia mutação', async () => {
    adminCommandAuditService.beginRequired.mockRejectedValueOnce(new Error('sqlite down'));
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(manualSubGrantService.extendGrant).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Não foi possível registrar a auditoria obrigatória desta ação. Operação recusada.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('concessão inexistente retorna mensagem segura e código MANUAL_GRANT_NOT_FOUND', async () => {
    manualSubGrantService.extendGrant.mockReturnValue({ extended: false, reason: 'not_found' });
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(adminCommandAuditService.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MANUAL_GRANT_NOT_FOUND' }),
    );
    expect(interaction.reply.mock.calls[0][0].content).toContain('Use /sub-grant');
  });

  test('concessão revogada não é reativada e retorna MANUAL_GRANT_REVOKED', async () => {
    manualSubGrantService.extendGrant.mockReturnValue({ extended: false, reason: 'revoked' });
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(adminCommandAuditService.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MANUAL_GRANT_REVOKED' }),
    );
  });

  test('concessão permanente não é convertida para temporária', async () => {
    manualSubGrantService.extendGrant.mockReturnValue({ extended: false, reason: 'not_extendable' });
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(adminCommandAuditService.finishFailed).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ errorCode: 'MANUAL_GRANT_NOT_EXTENDABLE' }),
    );
  });

  test('falha inesperada retorna mensagem segura sem detalhes internos', async () => {
    manualSubGrantService.extendGrant.mockImplementation(() => {
      throw new Error('sql stack trace token=abc');
    });

    const interaction = makeInteraction();

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Não foi possível concluir a extensão da concessão manual no momento.');
    expect(payload.content).not.toMatch(/token|stack|sql/i);
  });

  test('idempotência: duplicate interaction não duplica mutação', async () => {
    adminCommandAuditService.beginRequired.mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), { code: 'DUPLICATE_INTERACTION' }),
    );
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(manualSubGrantService.extendGrant).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Esta interação já foi processada anteriormente.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });
});
