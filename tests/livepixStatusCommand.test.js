jest.mock('../src/services/livepixAuthService', () => ({
  getAuthenticatedAccount: jest.fn(),
}));

const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const livepixAuthService = require('../src/services/livepixAuthService');
const command = require('../src/commands/livepixStatus');

function createInteraction({ isAdmin = true, inGuild = true } = {}) {
  return {
    inGuild: () => inGuild,
    memberPermissions: {
      has: (permission) => permission === PermissionFlagsBits.Administrator && isAdmin,
    },
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

describe('/livepix-status command', () => {
  let warnSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('consulta e exibe apenas o status e username da conta', async () => {
    livepixAuthService.getAuthenticatedAccount.mockResolvedValue({
      id: 'private-account-id',
      email: 'private@example.test',
      username: 'livepix-user',
      displayName: 'Private Display Name',
    });
    const interaction = createInteraction();

    await command.execute(interaction);

    expect(livepixAuthService.getAuthenticatedAccount).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Conexão LivePix: ativa\nConta autenticada: livepix-user',
      allowedMentions: { parse: [] },
    });
    const reply = JSON.stringify(interaction.editReply.mock.calls[0][0]);
    expect(reply).not.toContain('private-account-id');
    expect(reply).not.toContain('private@example.test');
  });

  test('restringe o diagnóstico a Administrator', async () => {
    const interaction = createInteraction({ isAdmin: false });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Você precisa da permissão de Administrator para usar este comando.',
      flags: MessageFlags.Ephemeral,
    });
    expect(livepixAuthService.getAuthenticatedAccount).not.toHaveBeenCalled();
  });

  test('responde falha externa sem expor segredo/token ou mensagem da exceção', async () => {
    livepixAuthService.getAuthenticatedAccount.mockRejectedValue(
      Object.assign(new Error('client-secret-value access-token-value'), {
        code: 'UPSTREAM_UNAVAILABLE',
      }),
    );
    const interaction = createInteraction();

    await command.execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      'Conexão LivePix não verificada. Código: UPSTREAM_UNAVAILABLE.',
    );
    expect(warnSpy).toHaveBeenCalledWith('LivePix connection diagnostic failed code=UPSTREAM_UNAVAILABLE');
    expect(JSON.stringify(interaction.editReply.mock.calls[0][0])).not.toContain('client-secret-value');
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('access-token-value');
  });
});
