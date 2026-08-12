const { MessageFlags, PermissionFlagsBits } = require('discord.js');

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'guild-1';
process.env.SUBSCRIBER_ROLE_ID = process.env.SUBSCRIBER_ROLE_ID || 'sub-role-1';
delete process.env.BOT_OPERATOR_ROLE_IDS;

jest.mock('../src/database/kickAccountsRepository', () => ({
  findByDiscordId: jest.fn(),
  upsert: jest.fn(),
  deleteByDiscordId: jest.fn(),
  unlinkWithAudit: jest.fn(),
}));

jest.mock('../src/services/subscriberEligibilityService', () => ({
  getEligibility: jest.fn(),
}));

jest.mock('../src/services/adminCommandAuditService', () => ({
  beginRequired: jest.fn().mockResolvedValue({ auditId: 1 }),
  finishSuccess: jest.fn().mockResolvedValue({ auditSaved: true }),
  finishFailed: jest.fn().mockResolvedValue({ auditSaved: true }),
  finishDenied: jest.fn().mockResolvedValue({ auditSaved: true }),
}));

const kickAccountsRepository = require('../src/database/kickAccountsRepository');
const adminCommandAuditService = require('../src/services/adminCommandAuditService');
const subscriberEligibilityService = require('../src/services/subscriberEligibilityService');
const command = require('../src/commands/kickStatus');

function makePermissions(allowedFlags = []) {
  return {
    has: (flag) => allowedFlags.includes(flag),
  };
}

function makeGuildMember(options = {}) {
  const subscriberRoleId = process.env.SUBSCRIBER_ROLE_ID;
  const hasSubRole = options.hasSubRole === true;

  return {
    id: options.id || 'member-1',
    manageable: options.manageable !== false,
    permissions: makePermissions(options.allowedFlags || []),
    roles: {
      cache: {
        has: (roleId) => Boolean(hasSubRole && roleId === subscriberRoleId),
      },
    },
  };
}

function makeEligibility(overrides = {}) {
  const overrideSources = overrides.sources || {};
  const rest = { ...overrides };
  delete rest.sources;

  return {
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
        ...(overrideSources.kick || {}),
      },
      manual: {
        active: false,
        reason: null,
        grantedByDiscordId: null,
        grantedAtMs: null,
        expiresAtMs: null,
        ...(overrideSources.manual || {}),
      },
    },
    ...rest,
  };
}

function makeInteraction(options = {}) {
  const actorId = options.actorId || 'discord-actor';
  const actorUser = options.actorUser || { id: actorId };
  const requestedUser = options.requestedUser || null;

  const fetchMember = options.fetchMember || (async (discordId) => {
    if (discordId === actorId) {
      return makeGuildMember({
        id: actorId,
        allowedFlags: options.actorAllowedFlags || [],
        hasSubRole: options.selfHasSubRole,
        manageable: options.selfManageable,
      });
    }

    if (discordId === (requestedUser && requestedUser.id)) {
      return makeGuildMember({
        id: requestedUser.id,
        hasSubRole: options.targetHasSubRole,
        manageable: options.targetManageable,
      });
    }

    if (discordId === actorUser.id) {
      return makeGuildMember({
        id: actorUser.id,
        hasSubRole: options.selfHasSubRole,
        manageable: options.selfManageable,
      });
    }

    return null;
  });

  return {
    inGuild: () => options.inGuild !== false,
    guild: {
      members: {
        fetch: jest.fn(fetchMember),
      },
    },
    user: actorUser,
    options: {
      getUser: jest.fn().mockReturnValue(requestedUser),
    },
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('/kick-status command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BOT_OPERATOR_ROLE_IDS;

    adminCommandAuditService.beginRequired.mockResolvedValue({ auditId: 1 });
    adminCommandAuditService.finishSuccess.mockResolvedValue({ auditSaved: true });
    adminCommandAuditService.finishFailed.mockResolvedValue({ auditSaved: true });
    adminCommandAuditService.finishDenied.mockResolvedValue({ auditSaved: true });
    subscriberEligibilityService.getEligibility.mockReturnValue(makeEligibility());
    kickAccountsRepository.findByDiscordId.mockReturnValue(null);
  });

  test('parâmetro usuario é opcional no registro do comando', () => {
    const json = command.data.toJSON();
    const userOption = (json.options || []).find((option) => option.name === 'usuario');

    expect(userOption).toBeDefined();
    expect(userOption.required).toBe(false);
  });

  test('sem parâmetro consulta o próprio usuário', async () => {
    const interaction = makeInteraction({
      actorId: 'discord-self-1',
      selfHasSubRole: false,
      selfManageable: true,
    });

    await command.execute(interaction);

    expect(subscriberEligibilityService.getEligibility).toHaveBeenCalledWith('discord-self-1');
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  test('usuário comum consulta a si mesmo com usuario explícito', async () => {
    const interaction = makeInteraction({
      actorId: 'discord-self-2',
      requestedUser: { id: 'discord-self-2' },
    });

    await command.execute(interaction);

    expect(subscriberEligibilityService.getEligibility).toHaveBeenCalledWith('discord-self-2');
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  test('Administrator pode consultar outro membro', async () => {
    const interaction = makeInteraction({
      actorId: 'admin-1',
      requestedUser: { id: 'target-1' },
      actorAllowedFlags: [PermissionFlagsBits.Administrator],
    });

    await command.execute(interaction);

    expect(subscriberEligibilityService.getEligibility).toHaveBeenCalledWith('target-1');
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Usuário consultado: <@target-1>');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  test('Manage Guild pode consultar outro membro', async () => {
    const interaction = makeInteraction({
      actorId: 'mod-1',
      requestedUser: { id: 'target-2' },
      actorAllowedFlags: [PermissionFlagsBits.ManageGuild],
    });

    await command.execute(interaction);

    expect(subscriberEligibilityService.getEligibility).toHaveBeenCalledWith('target-2');
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  test('cargo operacional configurado pode consultar outro membro', async () => {
    process.env.BOT_OPERATOR_ROLE_IDS = '900000000000000123';
    jest.resetModules();
    const reloadedCommand = require('../src/commands/kickStatus');
    const reloadedAuditService = require('../src/services/adminCommandAuditService');
    const reloadedSubscriberEligibilityService = require('../src/services/subscriberEligibilityService');
    reloadedSubscriberEligibilityService.getEligibility.mockReturnValue(makeEligibility());
    const interaction = makeInteraction({
      actorId: 'mod-role-1',
      requestedUser: { id: 'target-role-1' },
      fetchMember: async (discordId) => {
        if (discordId === 'mod-role-1') {
          return {
            manageable: true,
            permissions: makePermissions([]),
            roles: { cache: { has: (roleId) => roleId === '900000000000000123' } },
          };
        }

        if (discordId === 'target-role-1') {
          return makeGuildMember({ id: 'target-role-1' });
        }

        return null;
      },
    });

    await reloadedCommand.execute(interaction);

    expect(reloadedSubscriberEligibilityService.getEligibility).toHaveBeenCalledWith('target-role-1');
    expect(reloadedAuditService.finishSuccess).toHaveBeenCalled();
    delete process.env.BOT_OPERATOR_ROLE_IDS;
  });

  test('usuário comum não consulta terceiro e resposta negada é privada', async () => {
    const interaction = makeInteraction({
      actorId: 'user-1',
      requestedUser: { id: 'target-3' },
      actorAllowedFlags: [],
    });

    await command.execute(interaction);

    expect(subscriberEligibilityService.getEligibility).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('autorização operacional'),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(adminCommandAuditService.finishDenied).toHaveBeenCalled();
  });

  test('não confia apenas no payload e valida permissões reais no guild member', async () => {
    const interaction = makeInteraction({
      actorId: 'payload-admin',
      requestedUser: { id: 'target-4' },
      actorAllowedFlags: [],
    });

    interaction.memberPermissions = makePermissions([PermissionFlagsBits.Administrator]);

    await command.execute(interaction);

    expect(interaction.guild.members.fetch).toHaveBeenCalledWith('payload-admin');
    expect(subscriberEligibilityService.getEligibility).not.toHaveBeenCalled();
  });

  test('consulta de terceiro usa auditoria obrigatória com alvo seguro', async () => {
    const interaction = makeInteraction({
      actorId: 'admin-audit-1',
      requestedUser: { id: 'target-audit-1' },
      actorAllowedFlags: [PermissionFlagsBits.Administrator],
    });

    await command.execute(interaction);

    expect(adminCommandAuditService.beginRequired).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({
        commandName: 'kick-status',
        parameters: {
          targetDiscordId: 'target-audit-1',
          queryScope: 'third_party',
        },
      }),
    );
    expect(adminCommandAuditService.finishSuccess).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        nextState: {
          targetDiscordId: 'target-audit-1',
          queryScope: 'third_party',
        },
      }),
    );
  });

  test('consulta própria não entra na auditoria administrativa', async () => {
    const interaction = makeInteraction({ actorId: 'discord-self-3' });

    await command.execute(interaction);

    expect(adminCommandAuditService.beginRequired).not.toHaveBeenCalled();
    expect(adminCommandAuditService.finishSuccess).not.toHaveBeenCalled();
  });

  test('usuário vinculado com assinatura ativa', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue(
      makeEligibility({
        eligible: true,
        sources: {
          kick: {
            linked: true,
            active: true,
            observed: true,
            kickUserId: '75942843',
            kickUsername: 'adrianroocha',
            startedAtMs: 1_720_000_000_000,
            expiresAtMs: 1_920_000_000_000,
            subscriptionType: 'direct',
          },
        },
      }),
    );

    kickAccountsRepository.findByDiscordId.mockReturnValue({
      linked_at_ms: 1_720_000_000_123,
    });

    const interaction = makeInteraction({ actorId: 'discord-10' });

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Conta Kick vinculada: sim');
    expect(payload.content).toContain('Conta Kick: adrianroocha');
    expect(payload.content).toContain('Kick ID: 75942843');
    expect(payload.content).toContain('Assinatura Kick: ativa');
    expect(payload.content).toContain('Tipo Kick: direta');
  });

  test('usuário vinculado sem assinatura observada', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue(
      makeEligibility({
        sources: {
          kick: {
            linked: true,
            active: false,
            observed: false,
            kickUserId: '88',
            kickUsername: 'nick88',
          },
        },
      }),
    );

    const interaction = makeInteraction({ actorId: 'discord-11' });
    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Assinatura Kick: ainda não observada por webhook');
    expect(payload.content).toContain('Tipo Kick: indisponível');
  });

  test('usuário sem vínculo Kick', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue(makeEligibility());

    const interaction = makeInteraction({ actorId: 'discord-12' });
    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Conta Kick vinculada: não');
    expect(payload.content).toContain('Conta Kick: não vinculada');
    expect(payload.content).toContain('Assinatura Kick: indisponível');
  });

  test('concessão manual ativa aparece sem vínculo Kick', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue(
      makeEligibility({
        eligible: true,
        sources: {
          manual: {
            active: true,
            reason: 'Pix',
            grantedByDiscordId: 'admin-1',
            grantedAtMs: 1_000,
            expiresAtMs: null,
          },
        },
      }),
    );

    const interaction = makeInteraction({ actorId: 'discord-13' });
    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Concessão manual: ativa');
    expect(payload.content).toContain('Motivo manual: Pix');
    expect(payload.content).toContain('Fontes ativas:\n- Concessão manual');
  });

  test('elegibilidade por Kick', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue(
      makeEligibility({
        eligible: true,
        sources: {
          kick: {
            linked: true,
            active: true,
            observed: true,
            kickUserId: '901',
            kickUsername: 'kick901',
            subscriptionType: 'gifted',
          },
        },
      }),
    );

    const interaction = makeInteraction({ actorId: 'discord-14' });
    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Elegibilidade: ativa');
    expect(payload.content).toContain('Fontes ativas:\n- Kick');
  });

  test('elegibilidade por concessão manual', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue(
      makeEligibility({
        eligible: true,
        sources: {
          manual: {
            active: true,
            reason: 'Cortesia',
            grantedByDiscordId: 'admin-2',
            grantedAtMs: 2_000,
            expiresAtMs: 3_000,
          },
        },
      }),
    );

    const interaction = makeInteraction({ actorId: 'discord-15' });
    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Elegibilidade: ativa');
    expect(payload.content).toContain('Fontes ativas:\n- Concessão manual');
  });

  test('elegibilidade por ambas as fontes', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue(
      makeEligibility({
        eligible: true,
        sources: {
          kick: {
            linked: true,
            active: true,
            observed: true,
            kickUserId: '500',
            kickUsername: 'kick500',
            subscriptionType: 'direct',
          },
          manual: {
            active: true,
            reason: 'Cortesia',
            grantedByDiscordId: 'admin-3',
            grantedAtMs: 5_000,
            expiresAtMs: null,
          },
        },
      }),
    );

    const interaction = makeInteraction({ actorId: 'discord-16' });
    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Fontes ativas:\n- Kick\n- Concessão manual');
  });

  test('cargo SUB presente', async () => {
    const interaction = makeInteraction({
      actorId: 'discord-17',
      selfHasSubRole: true,
    });

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Cargo SUB: presente');
  });

  test('cargo SUB ausente', async () => {
    const interaction = makeInteraction({
      actorId: 'discord-18',
      selfHasSubRole: false,
    });

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Cargo SUB: ausente');
  });

  test('membro não gerenciável pelo bot', async () => {
    const interaction = makeInteraction({
      actorId: 'discord-19',
      selfManageable: false,
    });

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Membro gerenciável pelo bot: não gerenciável');
  });

  test('falha ao consultar membro/cargo não impede demais dados', async () => {
    const interaction = makeInteraction({
      actorId: 'discord-20',
      fetchMember: async () => {
        throw new Error('discord fetch error');
      },
    });

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Conta Kick: não vinculada');
    expect(payload.content).toContain('Cargo SUB: indisponível');
    expect(payload.content).toContain('Membro gerenciável pelo bot: indisponível');
  });

  test('consulta em DM mantém comportamento atual para consulta própria', async () => {
    const interaction = makeInteraction({
      inGuild: false,
      actorId: 'discord-dm-1',
    });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(subscriberEligibilityService.getEligibility).not.toHaveBeenCalled();
  });

  test('consulta de terceiro em DM é recusada', async () => {
    const interaction = makeInteraction({
      inGuild: false,
      actorId: 'discord-dm-2',
      requestedUser: { id: 'target-dm-1' },
    });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(subscriberEligibilityService.getEligibility).not.toHaveBeenCalled();
  });

  test('membro alvo ausente no servidor é recusado com segurança', async () => {
    const interaction = makeInteraction({
      actorId: 'admin-2',
      requestedUser: { id: 'target-missing' },
      actorAllowedFlags: [PermissionFlagsBits.Administrator],
      fetchMember: async (discordId) => {
        if (discordId === 'admin-2') {
          return makeGuildMember({
            id: 'admin-2',
            allowedFlags: [PermissionFlagsBits.Administrator],
          });
        }
        return null;
      },
    });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'O usuário informado não está disponível neste servidor.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('falha de leitura retorna mensagem segura sem secrets, state ou stack trace', async () => {
    subscriberEligibilityService.getEligibility.mockImplementation(() => {
      throw new Error(
        'db fail token=abc refresh=def oauth_state=xyz stack=Error: x at y path=C:/secret KICK_CLIENT_SECRET=123',
      );
    });

    const interaction = makeInteraction({ actorId: 'discord-21' });
    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Código: KICK_STATUS_READ_FAILED');
    expect(payload.content).not.toContain('token=');
    expect(payload.content).not.toContain('refresh=');
    expect(payload.content).not.toContain('oauth_state');
    expect(payload.content).not.toContain('stack=');
    expect(payload.content).not.toContain('KICK_CLIENT_SECRET');
  });

  test('mantém informações centrais do formato atual e não altera banco', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue(
      makeEligibility({
        sources: {
          kick: {
            linked: true,
            active: false,
            observed: false,
            kickUserId: '102',
            kickUsername: 'user102',
          },
        },
      }),
    );

    kickAccountsRepository.findByDiscordId.mockReturnValue({
      linked_at_ms: 1_700_000_000_000,
    });

    const interaction = makeInteraction({ actorId: 'discord-22' });
    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toContain('Conta Kick: user102');
    expect(payload.content).toContain('Kick ID: 102');
    expect(payload.content).toContain('Vinculada em: <t:1700000000:F>');
    expect(payload.content).toContain('Assinatura Kick: ainda não observada por webhook');
    expect(payload.content).toContain('Elegibilidade: inativa');
    expect(payload.content).toContain('Prioridade da fila: definida por snapshot na primeira entrada do usuário em cada ciclo.');

    expect(kickAccountsRepository.upsert).not.toHaveBeenCalled();
    expect(kickAccountsRepository.deleteByDiscordId).not.toHaveBeenCalled();
    expect(kickAccountsRepository.unlinkWithAudit).not.toHaveBeenCalled();
  });
});
