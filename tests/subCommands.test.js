jest.mock('../src/services/manualSubGrantService', () => ({
  createGrant: jest.fn(),
  revokeGrant: jest.fn(),
  getStatus: jest.fn(),
  hasActiveGrant: jest.fn(),
}));

jest.mock('../src/services/queueService', () => ({
  addToQueue: jest.fn(),
  removeFromQueue: jest.fn(),
  getQueue: jest.fn(),
}));

const { PermissionFlagsBits } = require('discord.js');
const service = require('../src/services/manualSubGrantService');
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

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(service.createGrant).not.toHaveBeenCalled();
  });

  test('recusa em DM', async () => {
    const interaction = makeBaseInteraction({ inGuild: () => false });

    await subGrantCommand.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
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
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
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
        ephemeral: true,
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

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Concessão manual revogada.');
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
    service.getStatus.mockReturnValue({
      active: {
        reason: 'Pix',
        grantedByDiscordId: 'admin-1',
        grantedAtMs: 10_000,
        expiresAtMs: null,
      },
      latestGrant: null,
      latestRevocation: null,
      history: [],
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
    expect(payload.content).toContain('Kick: ainda não sincronizada');
    expect(payload.content).toContain('Cargo: ainda não sincronizado nesta etapa');
  });

  test('status expirado (inativo com último grant)', async () => {
    service.getStatus.mockReturnValue({
      active: null,
      latestGrant: {
        reason: 'Cortesia expirada',
        grantedByDiscordId: 'admin-1',
        grantedAtMs: 10_000,
        expiresAtMs: 12_000,
      },
      latestRevocation: null,
      history: [],
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
    expect(payload.content).toContain('Concessão manual: inativa');
    expect(payload.content).toContain('Último motivo: Cortesia expirada');
  });

  test('status revogado mostra última revogação', async () => {
    service.getStatus.mockReturnValue({
      active: null,
      latestGrant: {
        reason: 'Convidado',
        grantedByDiscordId: 'admin-1',
        grantedAtMs: 10_000,
        expiresAtMs: null,
      },
      latestRevocation: {
        revokedByDiscordId: 'admin-2',
        revokedAtMs: 20_000,
        revokeReason: 'Revogado',
      },
      history: [],
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
    expect(payload.content).toContain('Última revogação por: <@admin-2>');
    expect(payload.content).toContain('Motivo da revogação: Revogado');
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
