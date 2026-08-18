const { PermissionFlagsBits } = require('discord.js');
const {
  createTestContext,
  getDb,
  insertLobby,
  insertLobbyPlayer,
  seedQueueEntry,
} = require('./helpers/testDatabase');

const ACTOR_ID = '100000000000000001';
const USER_A = '123456789012345678';
const USER_B = '987654321098765432';

const DAY_MS = 24 * 60 * 60 * 1000;

function createAuditChannelCapture() {
  const send = jest.fn().mockResolvedValue(undefined);
  const channel = {
    guildId: 'test-guild',
    type: 0,
    isTextBased: () => true,
    send,
  };

  return {
    send,
    client: {
      channels: {
        fetch: jest.fn().mockResolvedValue(channel),
      },
    },
    lastPayload() {
      expect(send).toHaveBeenCalled();
      return send.mock.calls[send.mock.calls.length - 1][0];
    },
  };
}

function makeMemberFetch({ actorId, actorFlags, actorRoleIds = [] }) {
  return jest.fn(async (discordId) => {
    if (discordId === actorId) {
      return {
        manageable: true,
        permissions: { has: (flag) => actorFlags.includes(flag) },
        roles: { cache: { has: (roleId) => actorRoleIds.includes(roleId) } },
      };
    }

    return {
      id: discordId,
      manageable: true,
      permissions: { has: () => false },
      roles: { cache: { has: () => false } },
    };
  });
}

describe('apresentacao de alvos na auditoria administrativa (integracao real)', () => {
  let context;
  let db;
  let auditChannel;

  beforeEach(async () => {
    context = await createTestContext({
      nodeEnv: 'test',
      adminAuditChannelId: 'audit-channel-1',
      subscriberRoleId: 'sub-role-1',
      botOperatorRoleIds: '',
    });
    db = getDb(context.sqliteClient);
    auditChannel = createAuditChannelCapture();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  function seedSwapScenario() {
    insertLobby(db, { id: 10, lobbyNumber: 3, status: 'forming', creationType: 'automatic', createdAtMs: 20_000 });
    insertLobbyPlayer(db, {
      id: 100,
      lobbyId: 10,
      discordId: USER_A,
      username: 'User A#0001',
      displayName: 'User A',
      position: 2,
      originalJoinedAtMs: 10_000,
      isSubscriber: 0,
    });
    insertLobbyPlayer(db, {
      id: 101,
      lobbyId: 10,
      discordId: 'player-c',
      username: 'Player C#0001',
      displayName: 'Player C',
      position: 1,
      originalJoinedAtMs: 9_000,
      isSubscriber: 0,
    });
    seedQueueEntry(db, {
      id: 2,
      discordId: USER_B,
      username: 'User B#0001',
      displayName: 'User B',
      isSubscriber: 1,
      joinedAtMs: 16_000,
      queueOrderKey: 200,
    });
  }

  function makeSwapInteraction({ id = 'int-swap-1', actorFlags = [PermissionFlagsBits.ManageGuild] } = {}) {
    return {
      id,
      commandName: 'lobby-swap',
      guildId: 'test-guild',
      channelId: 'channel-1',
      inGuild: () => true,
      user: { id: ACTOR_ID, username: 'moderator' },
      guild: { members: { fetch: makeMemberFetch({ actorId: ACTOR_ID, actorFlags }) } },
      options: {
        getUser: jest.fn((name) => {
          if (name === 'usuario_a') {
            return { id: USER_A };
          }
          if (name === 'usuario_b') {
            return { id: USER_B };
          }
          return null;
        }),
        getString: jest.fn((name) => (name === 'motivo' ? 'troca validada' : null)),
      },
      client: auditChannel.client,
      reply: jest.fn().mockResolvedValue(undefined),
    };
  }

  function makeRemoveInteraction({ id = 'int-remove-1', actorFlags = [PermissionFlagsBits.ManageGuild] } = {}) {
    return {
      id,
      commandName: 'lobby-remove',
      guildId: 'test-guild',
      channelId: 'channel-1',
      inGuild: () => true,
      user: { id: ACTOR_ID, username: 'moderator' },
      guild: { members: { fetch: makeMemberFetch({ actorId: ACTOR_ID, actorFlags }) } },
      options: {
        getUser: jest.fn((name) => (name === 'usuario' ? { id: USER_A } : null)),
        getString: jest.fn((name) => (name === 'motivo' ? 'Jogador ausente' : null)),
      },
      client: auditChannel.client,
      reply: jest.fn().mockResolvedValue(undefined),
    };
  }

  describe('/lobby-swap', () => {
    test('sucesso mostra usuario A e usuario B com executor separado e sem ping', async () => {
      seedSwapScenario();
      const command = require('../src/commands/lobbySwap');
      const auditRepository = require('../src/database/adminCommandAuditLogsRepository');

      await command.execute(makeSwapInteraction());

      const latest = auditRepository.findLatest();
      expect(latest.result).toBe('success');

      const payload = auditChannel.lastPayload();
      expect(payload.allowedMentions).toEqual({ parse: [], users: [], roles: [] });
      expect(payload.content).toContain('Comando: /lobby-swap');
      expect(payload.content).toContain(`Moderador: moderator`);
      expect(payload.content).toContain(`ID do moderador: ${ACTOR_ID}`);
      expect(payload.content).toContain('Alvos:');
      expect(payload.content).toContain(`Usuário A: <@${USER_A}> — ID: ${USER_A}`);
      expect(payload.content).toContain(`Usuário B: <@${USER_B}> — ID: ${USER_B}`);
      expect(payload.content).toContain('origem: Lobby #3');
      expect(payload.content).toContain('Lobbies envolvidas: #3');
      expect(payload.content.match(/<@\d{17,20}>/g)).toEqual([`<@${USER_A}>`, `<@${USER_B}>`]);
      expect(payload.content.length).toBeLessThanOrEqual(2000);
    });

    test('historico in_game do jogador reentrante nao vira alvo adicional', async () => {
      seedSwapScenario();
      insertLobby(db, { id: 9, lobbyNumber: 1, status: 'in_game', creationType: 'automatic', createdAtMs: 5_000 });
      insertLobbyPlayer(db, {
        id: 90,
        lobbyId: 9,
        discordId: USER_B,
        username: 'User B#0001',
        displayName: 'User B',
        position: 1,
        originalJoinedAtMs: 4_000,
        isSubscriber: 1,
      });

      const command = require('../src/commands/lobbySwap');
      const auditRepository = require('../src/database/adminCommandAuditLogsRepository');

      await command.execute(makeSwapInteraction({ id: 'int-swap-reentered' }));

      expect(auditRepository.findLatest().result).toBe('success');

      const payload = auditChannel.lastPayload();
      expect(payload.content.match(/<@\d{17,20}>/g)).toEqual([`<@${USER_A}>`, `<@${USER_B}>`]);
    });

    test('denied mostra os dois alvos informados e nao confunde ator com alvo', async () => {
      seedSwapScenario();
      const command = require('../src/commands/lobbySwap');
      const auditRepository = require('../src/database/adminCommandAuditLogsRepository');

      await command.execute(makeSwapInteraction({ id: 'int-swap-denied', actorFlags: [] }));

      expect(auditRepository.findLatest().result).toBe('denied');

      const payload = auditChannel.lastPayload();
      expect(payload.content).toContain(`Usuário A: <@${USER_A}>`);
      expect(payload.content).toContain(`Usuário B: <@${USER_B}>`);
      expect(payload.content).toContain(`ID do moderador: ${ACTOR_ID}`);
      expect(payload.content).not.toContain(`<@${ACTOR_ID}>`);
      expect(payload.content).toContain('Resultado: recusada');
    });

    test('failed mostra os alvos fornecidos', async () => {
      const command = require('../src/commands/lobbySwap');
      const auditRepository = require('../src/database/adminCommandAuditLogsRepository');

      await command.execute(makeSwapInteraction({ id: 'int-swap-failed' }));

      expect(auditRepository.findLatest().result).toBe('failed');

      const payload = auditChannel.lastPayload();
      expect(payload.content).toContain(`Usuário A: <@${USER_A}>`);
      expect(payload.content).toContain(`Usuário B: <@${USER_B}>`);
    });
  });

  describe('/lobby-remove', () => {
    function seedRemoveScenario() {
      insertLobby(db, { id: 10, lobbyNumber: 3, status: 'forming', creationType: 'automatic', createdAtMs: 20_000 });
      insertLobbyPlayer(db, {
        id: 100,
        lobbyId: 10,
        discordId: USER_A,
        username: 'Target#0001',
        displayName: 'Target',
        position: 2,
        originalJoinedAtMs: 10_000,
        isSubscriber: 0,
      });
      insertLobbyPlayer(db, {
        id: 101,
        lobbyId: 10,
        discordId: 'player-c',
        username: 'Player C#0001',
        displayName: 'Player C',
        position: 1,
        originalJoinedAtMs: 9_000,
        isSubscriber: 0,
      });
    }

    test('sucesso mostra o jogador removido e o executor separadamente', async () => {
      seedRemoveScenario();
      const command = require('../src/commands/lobbyRemove');
      const auditRepository = require('../src/database/adminCommandAuditLogsRepository');

      await command.execute(makeRemoveInteraction());

      expect(auditRepository.findLatest().result).toBe('success');

      const payload = auditChannel.lastPayload();
      expect(payload.allowedMentions).toEqual({ parse: [], users: [], roles: [] });
      expect(payload.content).toContain(`Alvo: <@${USER_A}>`);
      expect(payload.content).toContain(`ID do alvo: ${USER_A}`);
      expect(payload.content).toContain(`ID do moderador: ${ACTOR_ID}`);
      expect(payload.content).not.toContain(`<@${ACTOR_ID}>`);
    });

    test('recusa mostra o alvo informado sem confundir com o ator', async () => {
      seedRemoveScenario();
      const command = require('../src/commands/lobbyRemove');
      const auditRepository = require('../src/database/adminCommandAuditLogsRepository');

      await command.execute(makeRemoveInteraction({ id: 'int-remove-denied', actorFlags: [] }));

      expect(auditRepository.findLatest().result).toBe('denied');

      const payload = auditChannel.lastPayload();
      expect(payload.content).toContain(`Alvo: <@${USER_A}>`);
      expect(payload.content).toContain(`ID do moderador: ${ACTOR_ID}`);
      expect(payload.content).toContain('Resultado: recusada');
    });

    test('falha nao confunde ator com alvo', async () => {
      const command = require('../src/commands/lobbyRemove');
      const auditRepository = require('../src/database/adminCommandAuditLogsRepository');

      await command.execute(makeRemoveInteraction({ id: 'int-remove-failed' }));

      expect(auditRepository.findLatest().result).toBe('failed');

      const payload = auditChannel.lastPayload();
      expect(payload.content).toContain(`Alvo: <@${USER_A}>`);
      expect(payload.content).not.toContain(`<@${ACTOR_ID}>`);
    });
  });

  describe('/sub-grant-extend', () => {
    const NOW_MS = 1_726_000_000_000;

    function seedGrant() {
      db.prepare(
        `INSERT INTO manual_sub_grants (
          discord_id,
          granted_by_discord_id,
          reason,
          granted_at_ms,
          expires_at_ms,
          revoked_at_ms,
          revoked_by_discord_id,
          revoke_reason
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      ).run(USER_A, 'admin-original', 'Grant inicial', NOW_MS - 20 * DAY_MS, NOW_MS + 10 * DAY_MS);
    }

    function makeExtendInteraction({ id = 'int-extend-1', actorFlags = [PermissionFlagsBits.Administrator] } = {}) {
      return {
        id,
        commandName: 'sub-grant-extend',
        guildId: 'test-guild',
        channelId: 'channel-1',
        inGuild: () => true,
        user: { id: ACTOR_ID, username: 'adminUser' },
        guild: { members: { fetch: makeMemberFetch({ actorId: ACTOR_ID, actorFlags }) } },
        options: {
          getUser: jest.fn((name) => (name === 'usuario' ? { id: USER_A, bot: false } : null)),
          getInteger: jest.fn((name) => (name === 'dias' ? 20 : null)),
          getString: jest.fn((name) => (name === 'motivo' ? 'Renovacao via PIX' : null)),
        },
        client: auditChannel.client,
        reply: jest.fn().mockResolvedValue(undefined),
      };
    }

    test('sucesso mostra o beneficiario sem expor motivo ou dados sensiveis', async () => {
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      try {
        seedGrant();
        const command = require('../src/commands/subGrantExtend');
        const auditRepository = require('../src/database/adminCommandAuditLogsRepository');

        await command.execute(makeExtendInteraction());

        expect(auditRepository.findLatest().result).toBe('success');

        const payload = auditChannel.lastPayload();
        expect(payload.content).toContain(`Alvo: <@${USER_A}>`);
        expect(payload.content).toContain(`ID do alvo: ${USER_A}`);
        expect(payload.content).not.toContain('Renovacao via PIX');
        expect(payload.content).not.toMatch(/token|secret|stack|exception/i);
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    test('operador sem Administrator continua recusado e a auditoria mostra o beneficiario', async () => {
      const command = require('../src/commands/subGrantExtend');
      const auditRepository = require('../src/database/adminCommandAuditLogsRepository');
      const grantsBefore = db.prepare('SELECT COUNT(1) AS total FROM manual_sub_grants').get().total;

      await command.execute(
        makeExtendInteraction({ id: 'int-extend-denied', actorFlags: [PermissionFlagsBits.ManageGuild] }),
      );

      expect(auditRepository.findLatest().result).toBe('denied');
      expect(db.prepare('SELECT COUNT(1) AS total FROM manual_sub_grants').get().total).toBe(grantsBefore);

      const payload = auditChannel.lastPayload();
      expect(payload.content).toContain(`Alvo: <@${USER_A}>`);
      expect(payload.content).not.toContain('Renovacao via PIX');
    });
  });

  describe('/kick-status consulta administrativa de terceiro', () => {
    test('mostra o Discord ID do membro consultado sem dados sensiveis da Kick', async () => {
      jest.doMock('../src/services/subscriberEligibilityService', () => ({
        getEligibility: jest.fn(() => ({
          eligible: true,
          sources: {
            kick: {
              linked: true,
              active: true,
              observed: true,
              kickUserId: '75942843',
              kickUsername: 'sensitive-kick-user',
              startedAtMs: 1_000,
              expiresAtMs: 2_000,
              subscriptionType: 'direct',
            },
            manual: { active: false },
          },
        })),
      }));

      const command = require('../src/commands/kickStatus');
      const auditRepository = require('../src/database/adminCommandAuditLogsRepository');
      const kickAccountsRepository = require('../src/database/kickAccountsRepository');
      jest.spyOn(kickAccountsRepository, 'findByDiscordId').mockReturnValue({ linked_at_ms: 5000 });

      await command.execute({
        id: 'int-kick-status-1',
        commandName: 'kick-status',
        guildId: 'test-guild',
        channelId: 'channel-1',
        inGuild: () => true,
        user: { id: ACTOR_ID, username: 'adminUser' },
        guild: {
          members: { fetch: makeMemberFetch({ actorId: ACTOR_ID, actorFlags: [PermissionFlagsBits.Administrator] }) },
        },
        options: { getUser: jest.fn().mockReturnValue({ id: USER_A }) },
        client: auditChannel.client,
        reply: jest.fn().mockResolvedValue(undefined),
      });

      expect(auditRepository.findLatest().result).toBe('success');

      const payload = auditChannel.lastPayload();
      expect(payload.content).toContain(`Alvo: <@${USER_A}>`);
      expect(payload.content).toContain(`ID do alvo: ${USER_A}`);
      expect(payload.content).not.toContain('sensitive-kick-user');
      expect(payload.content).not.toContain('75942843');
    });

    test('consulta propria continua fora da auditoria administrativa', async () => {
      jest.doMock('../src/services/subscriberEligibilityService', () => ({
        getEligibility: jest.fn(() => ({ eligible: false, sources: { kick: { linked: false }, manual: { active: false } } })),
      }));

      const command = require('../src/commands/kickStatus');
      const auditRepository = require('../src/database/adminCommandAuditLogsRepository');

      await command.execute({
        id: 'int-kick-status-self',
        commandName: 'kick-status',
        guildId: 'test-guild',
        channelId: 'channel-1',
        inGuild: () => true,
        user: { id: ACTOR_ID, username: 'adminUser' },
        guild: {
          members: { fetch: makeMemberFetch({ actorId: ACTOR_ID, actorFlags: [PermissionFlagsBits.Administrator] }) },
        },
        options: { getUser: jest.fn().mockReturnValue({ id: ACTOR_ID }) },
        client: auditChannel.client,
        reply: jest.fn().mockResolvedValue(undefined),
      });

      expect(auditRepository.findLatest()).toBeNull();
      expect(auditChannel.send).not.toHaveBeenCalled();
    });
  });
});
