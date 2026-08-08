jest.mock('../src/config', () => ({
  guildId: 'guild-1',
}));

jest.mock('../src/services/subscriberRoleReconciliationService', () => ({
  reconcileAll: jest.fn(),
}));

jest.mock('../src/services/queueService', () => ({
  addToQueue: jest.fn(),
  removeFromQueue: jest.fn(),
  getQueue: jest.fn(),
}));

const { PermissionFlagsBits } = require('discord.js');
const command = require('../src/commands/subReconcile');
const reconciliationService = require('../src/services/subscriberRoleReconciliationService');
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
      getString: jest.fn().mockReturnValue('Reconciliação manual'),
    },
    client: {},
    reply: jest.fn().mockResolvedValue(undefined),
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('/sub-reconcile command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reconciliationService.reconcileAll.mockResolvedValue({
      status: 'completed',
      totalCandidates: 10,
      processed: 10,
      roleAdded: 2,
      roleRemoved: 3,
      alreadyCorrect: 4,
      skipped: 1,
      failed: 0,
      skippedByCode: { member_not_found: 1 },
      failedByCode: {},
      auditWarnings: {},
      memberRoleDiscoveryComplete: true,
      warnings: [],
    });
  });

  test('somente Administrator', async () => {
    const interaction = makeInteraction({ memberPermissions: makePermissions(false) });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(reconciliationService.reconcileAll).not.toHaveBeenCalled();
  });

  test('recusa em DM', async () => {
    const interaction = makeInteraction({ inGuild: () => false });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  test('recusa em outro guild', async () => {
    const interaction = makeInteraction({ guildId: 'guild-2' });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(reconciliationService.reconcileAll).not.toHaveBeenCalled();
  });

  test('deferReply ephemeral e executa reconciliação', async () => {
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(reconciliationService.reconcileAll).toHaveBeenCalledWith(
      expect.objectContaining({
        triggeredByDiscordId: 'admin-1',
        triggerType: 'command_sub_reconcile',
        reason: 'Reconciliação manual',
      }),
    );
    expect(interaction.editReply).toHaveBeenCalled();
  });

  test('motivo obrigatório rejeita vazio', async () => {
    const interaction = makeInteraction({
      options: {
        getString: jest.fn().mockReturnValue('   '),
      },
    });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'O motivo da reconciliação é obrigatório.',
        ephemeral: true,
      }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  test('quando já está em execução informa e não inicia nova', async () => {
    const interaction = makeInteraction();
    reconciliationService.reconcileAll.mockResolvedValue({ status: 'already_running' });

    await command.execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      'Já existe uma reconciliação de cargo SUB em andamento. Aguarde a conclusão para iniciar outra.',
    );
  });

  test('resumo final inclui contadores', async () => {
    const interaction = makeInteraction();

    await command.execute(interaction);

    const message = interaction.editReply.mock.calls[0][0];
    expect(message).toContain('Candidatos: 10');
    expect(message).toContain('Processados: 10');
    expect(message).toContain('Adicionados: 2');
    expect(message).toContain('Removidos: 3');
    expect(message).toContain('Já corretos: 4');
    expect(message).toContain('Ignorados: 1');
    expect(message).toContain('Ignorados por código: member_not_found=1');
    expect(message).toContain('Falhas: 0');
    expect(message).toContain('Falhas por código: nenhuma');
    expect(message).toContain('Descoberta completa de membros com SUB: sim');
  });

  test('resumo inclui falhas por código com segurança', async () => {
    const interaction = makeInteraction();
    reconciliationService.reconcileAll.mockResolvedValue({
      status: 'completed_with_failures',
      totalCandidates: 3,
      processed: 3,
      roleAdded: 0,
      roleRemoved: 0,
      alreadyCorrect: 2,
      skipped: 0,
      failed: 1,
      skippedByCode: {},
      failedByCode: { member_not_manageable: 1 },
      auditWarnings: { audit_failed: 1 },
      memberRoleDiscoveryComplete: true,
      warnings: [],
    });

    await command.execute(interaction);

    const message = interaction.editReply.mock.calls[0][0];
    expect(message).toContain('Falhas por código: member_not_manageable=1');
    expect(message).toContain('Avisos de auditoria: audit_failed=1');
  });

  test('sempre encerra deferReply com editReply quando serviço falha', async () => {
    const interaction = makeInteraction();
    reconciliationService.reconcileAll.mockRejectedValue(new Error('timeout'));

    await command.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply.mock.calls[0][0]).toContain('Reconciliação não pôde ser concluída');
  });

  test('sempre tenta editReply mesmo em status already_running', async () => {
    const interaction = makeInteraction();
    reconciliationService.reconcileAll.mockResolvedValue({ status: 'already_running' });

    await command.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
  });

  test('não altera fila', async () => {
    const interaction = makeInteraction();

    await command.execute(interaction);

    expect(queueService.addToQueue).not.toHaveBeenCalled();
    expect(queueService.removeFromQueue).not.toHaveBeenCalled();
    expect(queueService.getQueue).not.toHaveBeenCalled();
  });
});
