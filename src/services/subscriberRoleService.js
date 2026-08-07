const { PermissionFlagsBits } = require('discord.js');
const config = require('../config');

function createSubscriberRoleService(options = {}) {
  const cfg = options.config || config;

  async function getGuild(client) {
    if (!client || !client.guilds || typeof client.guilds.fetch !== 'function') {
      return { ok: false, result: 'guild_not_found' };
    }

    try {
      const guild = await client.guilds.fetch(cfg.guildId);
      if (!guild) {
        return { ok: false, result: 'guild_not_found' };
      }
      return { ok: true, guild };
    } catch (_error) {
      return { ok: false, result: 'guild_not_found' };
    }
  }

  async function getRole(guild) {
    if (!cfg.subscriberRoleId || !cfg.subscriberRoleId.trim()) {
      return { ok: false, result: 'role_not_found' };
    }

    try {
      const role = await guild.roles.fetch(cfg.subscriberRoleId.trim());
      if (!role) {
        return { ok: false, result: 'role_not_found' };
      }
      return { ok: true, role };
    } catch (_error) {
      return { ok: false, result: 'role_not_found' };
    }
  }

  function hasManageRoles(guild) {
    const me = guild.members?.me;
    if (!me || !me.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      return false;
    }
    return true;
  }

  function canManageRole(guild, role) {
    const me = guild.members?.me;
    if (!me || !me.roles?.highest || !role || typeof role.position !== 'number') {
      return false;
    }

    return me.roles.highest.comparePositionTo(role) > 0;
  }

  async function getMember(guild, discordId) {
    const normalizedId = typeof discordId === 'string' ? discordId.trim() : '';
    if (!normalizedId) {
      return { ok: false, result: 'member_not_found' };
    }

    try {
      const member = await guild.members.fetch(normalizedId);
      if (!member) {
        return { ok: false, result: 'member_not_found' };
      }
      return { ok: true, member };
    } catch (_error) {
      return { ok: false, result: 'member_not_found' };
    }
  }

  async function ensureRoleState(client, discordId, shouldHaveRole) {
    const guildResult = await getGuild(client);
    if (!guildResult.ok) {
      return { result: guildResult.result };
    }

    const { guild } = guildResult;

    const roleResult = await getRole(guild);
    if (!roleResult.ok) {
      return { result: roleResult.result };
    }

    const { role } = roleResult;

    if (!hasManageRoles(guild)) {
      return { result: 'missing_manage_roles', roleName: role.name };
    }

    if (!role.editable) {
      return { result: 'role_not_editable', roleName: role.name };
    }

    if (!canManageRole(guild, role)) {
      return { result: 'hierarchy_error', roleName: role.name };
    }

    const memberResult = await getMember(guild, discordId);
    if (!memberResult.ok) {
      return { result: memberResult.result, roleName: role.name };
    }

    const { member } = memberResult;

    if (!member.manageable) {
      return { result: 'member_not_manageable', roleName: role.name };
    }

    const hasRole = member.roles?.cache?.has(role.id) || false;

    if (shouldHaveRole) {
      if (hasRole) {
        return { result: 'already_present', roleName: role.name };
      }

      try {
        await member.roles.add(role.id);
        return { result: 'role_added', roleName: role.name };
      } catch (_error) {
        return { result: 'discord_api_error', roleName: role.name };
      }
    }

    if (!hasRole) {
      return { result: 'already_absent', roleName: role.name };
    }

    try {
      await member.roles.remove(role.id);
      return { result: 'role_removed', roleName: role.name };
    } catch (_error) {
      return { result: 'discord_api_error', roleName: role.name };
    }
  }

  return {
    ensureRoleState,
  };
}

const defaultService = createSubscriberRoleService();
defaultService.createSubscriberRoleService = createSubscriberRoleService;

module.exports = defaultService;
