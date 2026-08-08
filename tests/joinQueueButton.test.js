const { MessageFlags } = require('discord.js');
jest.mock('../src/services/queueService', () => ({
  isUserInQueue: jest.fn(),
  addToQueue: jest.fn(),
}));

jest.mock('../src/services/queueMessageService', () => ({
  updatePanel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/schedulerService', () => ({
  isQueueOpen: jest.fn(),
}));

jest.mock('../src/services/subscriberEligibilityService', () => ({
  getEligibility: jest.fn(),
}));

const queueService = require('../src/services/queueService');
const queueMessageService = require('../src/services/queueMessageService');
const schedulerService = require('../src/services/schedulerService');
const subscriberEligibilityService = require('../src/services/subscriberEligibilityService');
const button = require('../src/buttons/joinQueue');

function makeInteraction(overrides = {}) {
  return {
    user: { id: 'user-1', username: 'user', discriminator: '0001' },
    member: { displayName: 'Display User' },
    client: {},
    reply: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('joinQueue button', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    schedulerService.isQueueOpen.mockReturnValue(true);
    queueService.isUserInQueue.mockReturnValue(false);

    const cycleSnapshots = new Map();
    queueService.addToQueue.mockImplementation((payload) => {
      const existing = cycleSnapshots.get(payload.discordId);
      if (typeof existing === 'number') {
        return {
          success: true,
          joinedLobby: false,
          isSubscriber: existing,
          snapshotStatus: 'reused',
          snapshotResolution: { source: 'existing_snapshot', reliable: true },
        };
      }

      const resolved = payload.resolvePrioritySnapshot
        ? payload.resolvePrioritySnapshot({ discordId: payload.discordId })
        : { isSubscriber: payload.isSubscriber ? 1 : 0, source: 'provided', reliable: true };

      cycleSnapshots.set(payload.discordId, resolved.isSubscriber ? 1 : 0);
      return {
        success: true,
        joinedLobby: false,
        isSubscriber: resolved.isSubscriber ? 1 : 0,
        snapshotStatus: 'created',
        snapshotResolution: {
          source: resolved.source || 'eligibility',
          reliable: resolved.reliable !== false,
        },
      };
    });

    subscriberEligibilityService.getEligibility.mockReturnValue({
      eligible: false,
      sources: { kick: { active: false }, manual: { active: false } },
    });
  });

  test('primeira entrada elegivel cria snapshot SUB', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue({
      eligible: true,
      sources: { kick: { active: true }, manual: { active: false } },
    });

    const interaction = makeInteraction({ user: { id: 'cycle-a', username: 'cyclea', discriminator: '0001' } });
    await button.execute(interaction);

    expect(subscriberEligibilityService.getEligibility).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        content: expect.stringContaining('Prioridade SUB ativa.'),
      }),
    );
  });

  test('primeira entrada nao elegivel cria snapshot comum', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue({
      eligible: false,
      sources: { kick: { active: false }, manual: { active: false } },
    });

    const interaction = makeInteraction({ user: { id: 'cycle-b', username: 'cycleb', discriminator: '0001' } });
    await button.execute(interaction);

    expect(subscriberEligibilityService.getEligibility).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Entrada como participante comum.'),
      }),
    );
  });

  test('falha de elegibilidade cria snapshot comum', async () => {
    subscriberEligibilityService.getEligibility.mockImplementation(() => {
      throw new Error('eligibility down');
    });

    const interaction = makeInteraction({ user: { id: 'cycle-c', username: 'cyclec', discriminator: '0001' } });
    await button.execute(interaction);

    expect(subscriberEligibilityService.getEligibility).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Prioridade não pôde ser confirmada'),
      }),
    );
  });

  test('cargo Discord nao e usado como fonte', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue({
      eligible: false,
      sources: { kick: { active: false }, manual: { active: false } },
    });

    const interaction = makeInteraction({
      member: {
        displayName: 'Display User',
        roles: {
          cache: {
            has: jest.fn(() => true),
          },
        },
      },
    });

    await button.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Entrada como participante comum.'),
      }),
    );
  });

  test('reentrada no mesmo ciclo reaproveita snapshot sem nova consulta', async () => {
    subscriberEligibilityService.getEligibility
      .mockReturnValueOnce({
        eligible: true,
        sources: { kick: { active: true }, manual: { active: false } },
      })
      .mockReturnValueOnce({
        eligible: false,
        sources: { kick: { active: false }, manual: { active: false } },
      });

    const firstInteraction = makeInteraction({ user: { id: 'cycle-d', username: 'cycled', discriminator: '0001' } });
    const secondInteraction = makeInteraction({ user: { id: 'cycle-d', username: 'cycled', discriminator: '0001' } });

    await button.execute(firstInteraction);
    await button.execute(secondInteraction);

    expect(subscriberEligibilityService.getEligibility).toHaveBeenCalledTimes(1);
    expect(secondInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Categoria SUB do ciclo atual reaproveitada.'),
      }),
    );
  });

  test('mantem validacoes de duplicidade e lobby em formacao', async () => {
    const interactionDuplicate = makeInteraction();
    queueService.isUserInQueue.mockReturnValueOnce(true);

    await button.execute(interactionDuplicate);
    expect(interactionDuplicate.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Você já está na fila.',
        flags: MessageFlags.Ephemeral,
      }),
    );

    const interactionLobby = makeInteraction();
    queueService.isUserInQueue.mockReturnValueOnce(false);
    queueService.addToQueue.mockReturnValueOnce({ success: false, reason: 'in_forming_lobby' });

    await button.execute(interactionLobby);
    expect(interactionLobby.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Você já está em uma lobby em formação.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  test('atualiza painel ao sucesso', async () => {
    const interaction = makeInteraction();

    await button.execute(interaction);

    expect(queueMessageService.updatePanel).toHaveBeenCalledWith(interaction.client);
  });
});
