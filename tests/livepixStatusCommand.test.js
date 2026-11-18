jest.mock('../src/database/livepixAccountsRepository', () => ({
  findByDiscordId: jest.fn(),
}));
jest.mock('../src/services/adminCommandAuditService', () => ({
  beginRequired: jest.fn(),
  finishSuccess: jest.fn(),
  finishFailed: jest.fn(),
  finishDenied: jest.fn(),
}));
jest.mock('../src/services/operationalAuthorizationService', () => ({
  authorize: jest.fn(),
  codes: { MEMBER_UNAVAILABLE: 'MEMBER_UNAVAILABLE' },
}));

const { MessageFlags } = require('discord.js');
const livepixAccountsRepository = require('../src/database/livepixAccountsRepository');
const adminCommandAuditService = require('../src/services/adminCommandAuditService');
const operationalAuthorizationService = require('../src/services/operationalAuthorizationService');
const command = require('../src/commands/livepixStatus');

function makeInteraction({ actorId = 'discord-actor', requestedUser = null, inGuild = true } = {}) {
  const targetId = requestedUser?.id;
  return {
    inGuild: () => inGuild,
    user: { id: actorId },
    guild: {
      members: {
        fetch: jest.fn(async (discordId) => (discordId === targetId ? { id: targetId } : null)),
      },
    },
    client: {},
    options: {
      getUser: jest.fn().mockReturnValue(requestedUser),
    },
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('/livepix-status command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminCommandAuditService.beginRequired.mockResolvedValue({ auditId: 1 });
    adminCommandAuditService.finishSuccess.mockResolvedValue({ auditSaved: true });
    adminCommandAuditService.finishFailed.mockResolvedValue({ auditSaved: true });
    adminCommandAuditService.finishDenied.mockResolvedValue({ auditSaved: true });
    operationalAuthorizationService.authorize.mockResolvedValue({ allowed: true });
    livepixAccountsRepository.findByDiscordId.mockReturnValue(null);
  });

  test('usuario é opcional e permite consulta própria sem autorização administrativa', async () => {
    const option = command.data.toJSON().options.find((entry) => entry.name === 'usuario');
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(option.required).toBe(false);
    expect(livepixAccountsRepository.findByDiscordId).toHaveBeenCalledWith('discord-actor');
    expect(operationalAuthorizationService.authorize).not.toHaveBeenCalled();
    expect(adminCommandAuditService.beginRequired).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Conta LivePix vinculada: não'),
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('status vinculado exibe o ID armazenado sem consultar autenticação ou credenciais', async () => {
    livepixAccountsRepository.findByDiscordId.mockReturnValue({
      livepix_account_id: 'livepix-account-123',
    });
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('ID da conta LivePix: livepix-account-123'),
        allowedMentions: { parse: [] },
      }),
    );
    expect(JSON.stringify(interaction.reply.mock.calls[0][0])).not.toMatch(/token|secret|credential/i);
  });

  test('consulta terceiro autorizada é privada e auditada sem incluir o ID LivePix', async () => {
    livepixAccountsRepository.findByDiscordId.mockReturnValue({
      livepix_account_id: 'private-livepix-id',
    });
    const interaction = makeInteraction({ actorId: 'admin-1', requestedUser: { id: 'target-1' } });

    await command.execute(interaction);

    expect(operationalAuthorizationService.authorize).toHaveBeenCalledWith(interaction);
    expect(livepixAccountsRepository.findByDiscordId).toHaveBeenCalledWith('target-1');
    expect(adminCommandAuditService.beginRequired).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({
        commandName: 'livepix-status',
        parameters: { targetDiscordId: 'target-1', queryScope: 'third_party' },
      }),
    );
    expect(adminCommandAuditService.finishSuccess).toHaveBeenCalledWith(
      { auditId: 1 },
      expect.objectContaining({ nextState: { targetDiscordId: 'target-1', queryScope: 'third_party' } }),
    );
    expect(interaction.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(JSON.stringify(adminCommandAuditService.finishSuccess.mock.calls[0])).not.toContain('private-livepix-id');
  });

  test('usuário sem permissão não consulta vínculo de terceiro', async () => {
    operationalAuthorizationService.authorize.mockResolvedValue({
      allowed: false,
      code: 'MISSING_PERMISSION',
      reason: 'missing_permission',
    });
    const interaction = makeInteraction({ requestedUser: { id: 'target-2' } });

    await command.execute(interaction);

    expect(livepixAccountsRepository.findByDiscordId).not.toHaveBeenCalled();
    expect(adminCommandAuditService.finishDenied).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('autorização operacional'),
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('erro de consulta responde com código seguro sem detalhes internos', async () => {
    livepixAccountsRepository.findByDiscordId.mockImplementation(() => {
      throw new Error('client-secret-token');
    });
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('LIVEPIX_STATUS_READ_FAILED'),
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(interaction.reply.mock.calls[0][0].content).not.toContain('client-secret-token');
  });
});
