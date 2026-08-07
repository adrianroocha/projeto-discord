process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.GUILD_ID = process.env.GUILD_ID || 'guild-1';

const { createSubscriberRoleService } = require('../src/services/subscriberRoleService');

function createRole({ id = 'role-sub', name = 'sub', editable = true, position = 10 } = {}) {
  return { id, name, editable, position };
}

function createMember({ id = 'user-1', manageable = true, rolesCache = [], addImpl, removeImpl } = {}) {
  const cache = new Map(rolesCache.map((roleId) => [roleId, { id: roleId }]));

  return {
    id,
    manageable,
    roles: {
      cache: {
        has: (roleId) => cache.has(roleId),
      },
      add: addImpl || jest.fn(async (roleId) => {
        cache.set(roleId, { id: roleId });
      }),
      remove: removeImpl || jest.fn(async (roleId) => {
        cache.delete(roleId);
      }),
    },
  };
}

function createClient({
  guildFound = true,
  roleFound = true,
  memberFound = true,
  hasManageRoles = true,
  roleEditable = true,
  roleHigherThanBot = false,
  memberManageable = true,
  hasRoleInitially = false,
  addThrows = false,
  removeThrows = false,
} = {}) {
  const role = createRole({ editable: roleEditable, position: roleHigherThanBot ? 50 : 10 });
  const member = createMember({
    manageable: memberManageable,
    rolesCache: hasRoleInitially ? [role.id] : [],
    addImpl: addThrows ? jest.fn(async () => { throw new Error('discord add error'); }) : undefined,
    removeImpl: removeThrows ? jest.fn(async () => { throw new Error('discord remove error'); }) : undefined,
  });

  const guild = {
    members: {
      me: {
        permissions: {
          has: () => hasManageRoles,
        },
        roles: {
          highest: {
            comparePositionTo: () => (roleHigherThanBot ? -1 : 1),
          },
        },
      },
      fetch: jest.fn(async () => {
        if (!memberFound) {
          throw new Error('member not found');
        }
        return member;
      }),
    },
    roles: {
      fetch: jest.fn(async () => {
        if (!roleFound) {
          return null;
        }
        return role;
      }),
    },
  };

  const client = {
    guilds: {
      fetch: jest.fn(async () => {
        if (!guildFound) {
          throw new Error('guild not found');
        }
        return guild;
      }),
    },
  };

  return { client, guild, role, member };
}

describe('subscriberRoleService', () => {
  function makeService() {
    return createSubscriberRoleService({
      config: {
        guildId: 'guild-1',
        subscriberRoleId: 'role-sub',
      },
    });
  }

  test('adiciona cargo quando elegível e ausente', async () => {
    const service = makeService();
    const { client, member } = createClient({ hasRoleInitially: false });

    const result = await service.ensureRoleState(client, 'discord-1', true);

    expect(result.result).toBe('role_added');
    expect(member.roles.add).toHaveBeenCalledWith('role-sub');
  });

  test('remove cargo quando inelegível e presente', async () => {
    const service = makeService();
    const { client, member } = createClient({ hasRoleInitially: true });

    const result = await service.ensureRoleState(client, 'discord-2', false);

    expect(result.result).toBe('role_removed');
    expect(member.roles.remove).toHaveBeenCalledWith('role-sub');
  });

  test('já presente não reaplica', async () => {
    const service = makeService();
    const { client, member } = createClient({ hasRoleInitially: true });

    const result = await service.ensureRoleState(client, 'discord-3', true);

    expect(result.result).toBe('already_present');
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  test('já ausente não remove novamente', async () => {
    const service = makeService();
    const { client, member } = createClient({ hasRoleInitially: false });

    const result = await service.ensureRoleState(client, 'discord-4', false);

    expect(result.result).toBe('already_absent');
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  test('guild inexistente', async () => {
    const service = makeService();
    const { client } = createClient({ guildFound: false });
    const result = await service.ensureRoleState(client, 'discord-5', true);
    expect(result.result).toBe('guild_not_found');
  });

  test('cargo inexistente', async () => {
    const service = makeService();
    const { client } = createClient({ roleFound: false });
    const result = await service.ensureRoleState(client, 'discord-6', true);
    expect(result.result).toBe('role_not_found');
  });

  test('membro inexistente', async () => {
    const service = makeService();
    const { client } = createClient({ memberFound: false });
    const result = await service.ensureRoleState(client, 'discord-7', true);
    expect(result.result).toBe('member_not_found');
  });

  test('sem ManageRoles', async () => {
    const service = makeService();
    const { client } = createClient({ hasManageRoles: false });
    const result = await service.ensureRoleState(client, 'discord-8', true);
    expect(result.result).toBe('missing_manage_roles');
  });

  test('cargo acima do bot (hierarquia)', async () => {
    const service = makeService();
    const { client } = createClient({ roleHigherThanBot: true });
    const result = await service.ensureRoleState(client, 'discord-9', true);
    expect(result.result).toBe('hierarchy_error');
  });

  test('cargo não editável', async () => {
    const service = makeService();
    const { client } = createClient({ roleEditable: false });
    const result = await service.ensureRoleState(client, 'discord-10', true);
    expect(result.result).toBe('role_not_editable');
  });

  test('membro não gerenciável', async () => {
    const service = makeService();
    const { client } = createClient({ memberManageable: false });
    const result = await service.ensureRoleState(client, 'discord-11', true);
    expect(result.result).toBe('member_not_manageable');
  });

  test('membro não gerenciável inelegível e já sem SUB retorna already_absent', async () => {
    const service = makeService();
    const { client, member } = createClient({
      memberManageable: false,
      hasRoleInitially: false,
    });

    const result = await service.ensureRoleState(client, 'discord-11a', false);

    expect(result.result).toBe('already_absent');
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  test('membro não gerenciável elegível e já com SUB retorna already_present', async () => {
    const service = makeService();
    const { client, member } = createClient({
      memberManageable: false,
      hasRoleInitially: true,
    });

    const result = await service.ensureRoleState(client, 'discord-11b', true);

    expect(result.result).toBe('already_present');
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  test('membro não gerenciável elegível sem SUB retorna member_not_manageable', async () => {
    const service = makeService();
    const { client } = createClient({
      memberManageable: false,
      hasRoleInitially: false,
    });

    const result = await service.ensureRoleState(client, 'discord-11c', true);

    expect(result.result).toBe('member_not_manageable');
  });

  test('membro não gerenciável inelegível com SUB retorna member_not_manageable', async () => {
    const service = makeService();
    const { client } = createClient({
      memberManageable: false,
      hasRoleInitially: true,
    });

    const result = await service.ensureRoleState(client, 'discord-11d', false);

    expect(result.result).toBe('member_not_manageable');
  });

  test('erro da API Discord no add', async () => {
    const service = makeService();
    const { client } = createClient({ addThrows: true, hasRoleInitially: false });
    const result = await service.ensureRoleState(client, 'discord-12', true);
    expect(result.result).toBe('discord_api_error');
  });

  test('erro da API Discord no remove', async () => {
    const service = makeService();
    const { client } = createClient({ removeThrows: true, hasRoleInitially: true });
    const result = await service.ensureRoleState(client, 'discord-13', false);
    expect(result.result).toBe('discord_api_error');
  });

  test('somente o cargo SUB é alterado e outros cargos preservados', async () => {
    const service = makeService();
    const member = createMember({
      manageable: true,
      rolesCache: ['role-other'],
      addImpl: jest.fn(async () => {}),
    });

    const role = createRole({ id: 'role-sub', editable: true, position: 10 });
    const client = {
      guilds: {
        fetch: jest.fn(async () => ({
          members: {
            me: {
              permissions: { has: () => true },
              roles: { highest: { comparePositionTo: () => 1 } },
            },
            fetch: jest.fn(async () => member),
          },
          roles: {
            fetch: jest.fn(async () => role),
          },
        })),
      },
    };

    const result = await service.ensureRoleState(client, 'discord-14', true);

    expect(result.result).toBe('role_added');
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(member.roles.add).toHaveBeenCalledWith('role-sub');
  });
});
