const { MessageFlags } = require('discord.js');
jest.mock('../src/database/kickAccountsRepository', () => ({
  findByDiscordId: jest.fn(),
}));

jest.mock('../src/services/subscriberEligibilityService', () => ({
  getEligibility: jest.fn(),
}));

const kickAccountsRepository = require('../src/database/kickAccountsRepository');
const subscriberEligibilityService = require('../src/services/subscriberEligibilityService');
const command = require('../src/commands/kickStatus');

describe('/kick-status command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('usuário sem vínculo pode estar elegível apenas por concessão manual', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue({
      eligible: true,
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
          active: true,
          reason: 'Pix',
          grantedByDiscordId: 'admin-1',
          grantedAtMs: 1000,
          expiresAtMs: null,
        },
      },
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-1' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Conta Kick: não vinculada'),
        flags: MessageFlags.Ephemeral,
      }),
    );

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Concessão manual: ativa');
    expect(payload.content).toContain('Elegibilidade: ativa');
    expect(payload.content).toContain('Fontes ativas:\n- Concessão manual');
  });

  test('usuário com vínculo recebe username e kick id corretos', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue({
      eligible: false,
      sources: {
        kick: {
          linked: true,
          active: false,
          observed: false,
          kickUserId: '75942843',
          kickUsername: 'adrianroocha',
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

    kickAccountsRepository.findByDiscordId.mockReturnValue({
      discord_id: 'discord-2',
      kick_user_id: '75942843',
      kick_username: 'adrianroocha',
      linked_at_ms: 1_720_000_000_123,
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-2' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toContain('Conta Kick: adrianroocha');
    expect(payload.content).toContain('Kick ID: 75942843');
  });

  test('converte linked_at_ms para timestamp Discord em segundos', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue({
      eligible: false,
      sources: {
        kick: {
          linked: true,
          active: false,
          observed: false,
          kickUserId: '100',
          kickUsername: 'user100',
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

    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_user_id: '100',
      kick_username: 'user100',
      linked_at_ms: 1_725_111_222_999,
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-3' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('<t:1725111222:F>');
  });

  test('mostra elegibilidade inativa sem afirmar cargo sincronizado', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue({
      eligible: false,
      sources: {
        kick: {
          linked: true,
          active: false,
          observed: false,
          kickUserId: '101',
          kickUsername: 'user101',
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

    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_user_id: '101',
      kick_username: 'user101',
      linked_at_ms: 1_700_000_000_000,
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-4' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.content).toContain('Assinatura Kick: ainda não observada por webhook');
    expect(payload.content).toContain('Elegibilidade: inativa');
    expect(payload.content).toContain('Cargo SUB: sincronizado por gatilhos automáticos e reconciliação periódica.');
    expect(payload.content).toContain('Prioridade da fila: definida por snapshot na primeira entrada do usuário em cada ciclo.');
  });

  test('responde sempre ephemeral', async () => {
    subscriberEligibilityService.getEligibility.mockReturnValue({
      eligible: false,
      sources: {
        kick: {
          linked: true,
          active: false,
          observed: false,
          kickUserId: '102',
          kickUsername: 'user102',
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

    kickAccountsRepository.findByDiscordId.mockReturnValue({
      kick_user_id: '102',
      kick_username: 'user102',
      linked_at_ms: 1_700_000_000_000,
    });

    const interaction = {
      inGuild: () => true,
      user: { id: 'discord-5' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  test('recusa em DM', async () => {
    const interaction = {
      inGuild: () => false,
      user: { id: 'discord-dm' },
      reply: jest.fn().mockResolvedValue(undefined),
    };

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(subscriberEligibilityService.getEligibility).not.toHaveBeenCalled();
    expect(kickAccountsRepository.findByDiscordId).not.toHaveBeenCalled();
  });
});
