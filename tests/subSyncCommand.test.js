jest.mock('../src/config', () => ({
  guildId: 'guild-1',
}));

jest.mock('../src/services/subscriberRoleSyncService', () => ({
  syncUser: jest.fn(),
}));

jest.mock('../src/services/queueService', () => ({
  addToQueue: jest.fn(),
  removeFromQueue: jest.fn(),
  getQueue: jest.fn(),
}));

const { PermissionFlagsBits } = require('discord.js');
const command = require('../src/commands/subSync');
const syncService = require('../src/services/subscriberRoleSyncService');
const queueService = require('../src/services/queueService');

function makePermissions(isAdmin) {
  return {
    has: (flag) => isAdmin && flag === PermissionFlagsBits.Administrator,
  };
}

function makeInteraction(overrides = {}) {
  return {
    inGuild: () => true,
    guildId: 'guild-1',
    memberPermissions: makePermissions(true),
    user: { id: 'admin-1' },
    options: {
      getUser: jest.fn().mockReturnValue({ id: 'target-1', bot: false }),
      getString: jest.fn().mockReturnValue('Motivo de teste'),
    },
    client: {},
    reply: jest.fn().mockResolvedValue(undefined),
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('/sub-sync command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    syncService.syncUser.mockResolvedValue({
      eligibility: true,
      sources: { kick: false, manual: true },
      action: 'role_added',
      result: 'role_added',
      roleName: 'sub',
      auditSaved: true,
    });
  });

  test('somente Administrator', async () => {
    const interaction = makeInteraction({ memberPermissions: makePermissions(false) });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(syncService.syncUser).not.toHaveBeenCalled();
  });

  test('recusa em DM', async () => {
    const interaction = makeInteraction({ inGuild: () => false });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  test('recusa em outro guild', async () => {
    const interaction = makeInteraction({ guildId: 'guild-other' });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(syncService.syncUser).not.toHaveBeenCalled();
  });

  test('rejeita usuário bot', async () => {
    const interaction = makeInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'bot-1', bot: true }),
        getString: jest.fn().mockReturnValue('Motivo'),
      },
    });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(syncService.syncUser).not.toHaveBeenCalled();
  });

  test('deferReply ephemeral e executa sincronização', async () => {
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(syncService.syncUser).toHaveBeenCalledWith('target-1', expect.objectContaining({
      triggeredByDiscordId: 'admin-1',
      triggerType: 'command_sub_sync',
      reason: 'Motivo de teste',
    }));
    expect(interaction.editReply).toHaveBeenCalled();
  });

  test('motivo obrigatório (vazio) rejeita', async () => {
    const interaction = makeInteraction({
      options: {
        getUser: jest.fn().mockReturnValue({ id: 'target-2', bot: false }),
        getString: jest.fn().mockReturnValue('   '),
      },
    });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'O motivo da sincronização é obrigatório.',
        ephemeral: true,
      }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(syncService.syncUser).not.toHaveBeenCalled();
  });

  test('resposta inclui fontes ativas e ação', async () => {
    const interaction = makeInteraction();

    syncService.syncUser.mockResolvedValue({
      eligibility: false,
      sources: { kick: false, manual: false },
      action: 'already_correct',
      result: 'already_absent',
      roleName: 'sub',
      auditSaved: true,
    });

    await command.execute(interaction);

    const message = interaction.editReply.mock.calls[0][0];
    expect(message).toContain('Fontes ativas:');
    expect(message).toContain('- nenhuma');
    expect(message).toContain('Ação: já estava correto');
  });

  test('avisa quando auditoria falha', async () => {
    const interaction = makeInteraction();

    syncService.syncUser.mockResolvedValue({
      eligibility: true,
      sources: { kick: true, manual: false },
      action: 'role_added',
      result: 'role_added',
      roleName: 'sub',
      auditSaved: false,
      auditWarning: 'audit_failed',
    });

    await command.execute(interaction);

    const message = interaction.editReply.mock.calls[0][0];
    expect(message).toContain('Auditoria: não foi possível registrar esta tentativa');
  });

  test('não altera fila', async () => {
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(queueService.addToQueue).not.toHaveBeenCalled();
    expect(queueService.removeFromQueue).not.toHaveBeenCalled();
    expect(queueService.getQueue).not.toHaveBeenCalled();
  });

  test('schema possui usuario e motivo obrigatórios', () => {
    const json = command.data.toJSON();
    const userOption = json.options.find((option) => option.name === 'usuario');
    const reasonOption = json.options.find((option) => option.name === 'motivo');

    expect(userOption.required).toBe(true);
    expect(reasonOption.required).toBe(true);
  });
});
