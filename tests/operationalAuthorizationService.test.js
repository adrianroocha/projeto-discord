const { PermissionFlagsBits } = require('discord.js');
const { createOperationalAuthorizationService } = require('../src/services/operationalAuthorizationService');

function makeMember(options = {}) {
  const allowedFlags = options.allowedFlags || [];
  const roleIds = options.roleIds || [];

  return {
    permissions: {
      has: (flag) => allowedFlags.includes(flag),
    },
    roles: {
      cache: {
        has: (roleId) => roleIds.includes(roleId),
      },
    },
  };
}

function makeInteraction(fetchImpl, actorId = 'actor-1') {
  return {
    inGuild: () => true,
    guild: {
      members: {
        fetch: jest.fn(fetchImpl),
      },
    },
    user: { id: actorId },
  };
}

describe('operationalAuthorizationService', () => {
  test('permite Administrator', async () => {
    const service = createOperationalAuthorizationService({ config: { botOperatorRoleIds: [] } });
    const interaction = makeInteraction(async () => makeMember({
      allowedFlags: [PermissionFlagsBits.Administrator],
    }));

    const result = await service.authorize(interaction);

    expect(result.allowed).toBe(true);
    expect(result.via).toBe('administrator');
  });

  test('permite ManageGuild', async () => {
    const service = createOperationalAuthorizationService({ config: { botOperatorRoleIds: [] } });
    const interaction = makeInteraction(async () => makeMember({
      allowedFlags: [PermissionFlagsBits.ManageGuild],
    }));

    const result = await service.authorize(interaction);

    expect(result.allowed).toBe(true);
    expect(result.via).toBe('manage_guild');
  });

  test('permite cargo operacional configurado', async () => {
    const service = createOperationalAuthorizationService({
      config: { botOperatorRoleIds: ['123456789012345678', '234567890123456789'] },
    });
    const interaction = makeInteraction(async () => makeMember({
      roleIds: ['234567890123456789'],
    }));

    const result = await service.authorize(interaction);

    expect(result.allowed).toBe(true);
    expect(result.via).toBe('operator_role');
  });

  test('nega membro sem permissão operacional', async () => {
    const service = createOperationalAuthorizationService({
      config: { botOperatorRoleIds: ['123456789012345678'] },
    });
    const interaction = makeInteraction(async () => makeMember());

    const result = await service.authorize(interaction);

    expect(result.allowed).toBe(false);
    expect(result.code).toBe('MISSING_PERMISSION');
  });

  test('variável ausente preserva comportamento por permissão nativa', async () => {
    const service = createOperationalAuthorizationService({ config: {} });
    const interaction = makeInteraction(async () => makeMember({
      allowedFlags: [PermissionFlagsBits.ManageGuild],
    }));

    const result = await service.authorize(interaction);

    expect(result.allowed).toBe(true);
    expect(result.via).toBe('manage_guild');
  });

  test('falha com segurança quando membro não pode ser consultado', async () => {
    const service = createOperationalAuthorizationService({ config: { botOperatorRoleIds: [] } });
    const interaction = makeInteraction(async () => {
      throw new Error('discord fetch failed');
    });

    const result = await service.authorize(interaction);

    expect(result.allowed).toBe(false);
    expect(result.code).toBe('MEMBER_UNAVAILABLE');
  });
});