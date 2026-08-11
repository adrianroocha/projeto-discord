const { PermissionFlagsBits } = require('discord.js');

const OK_CODE = 'OK';
const MISSING_PERMISSION_CODE = 'MISSING_PERMISSION';
const MEMBER_UNAVAILABLE_CODE = 'MEMBER_UNAVAILABLE';
const GUILD_UNAVAILABLE_CODE = 'GUILD_UNAVAILABLE';

function hasPermission(member, permissionFlag) {
  return Boolean(member?.permissions?.has && member.permissions.has(permissionFlag));
}

function hasConfiguredOperatorRole(member, operatorRoleIds) {
  if (!Array.isArray(operatorRoleIds) || !operatorRoleIds.length) {
    return false;
  }

  return Boolean(member?.roles?.cache?.has) && operatorRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

async function fetchGuildMember(guild, discordId) {
  if (!guild?.members || typeof guild.members.fetch !== 'function') {
    return null;
  }

  try {
    return await guild.members.fetch(discordId);
  } catch {
    return null;
  }
}

function createOperationalAuthorizationService(options = {}) {
  const cfg = options.config || require('../config');

  async function authorize(interaction) {
    if ((typeof interaction?.inGuild === 'function' && !interaction.inGuild()) || !interaction?.guild) {
      return {
        allowed: false,
        code: GUILD_UNAVAILABLE_CODE,
        reason: 'guild_unavailable',
        member: null,
        via: null,
      };
    }

    const member = await fetchGuildMember(interaction.guild, interaction.user?.id);
    if (!member) {
      return {
        allowed: false,
        code: MEMBER_UNAVAILABLE_CODE,
        reason: 'member_unavailable',
        member: null,
        via: null,
      };
    }

    if (hasPermission(member, PermissionFlagsBits.Administrator)) {
      return {
        allowed: true,
        code: OK_CODE,
        reason: null,
        member,
        via: 'administrator',
      };
    }

    if (hasPermission(member, PermissionFlagsBits.ManageGuild)) {
      return {
        allowed: true,
        code: OK_CODE,
        reason: null,
        member,
        via: 'manage_guild',
      };
    }

    if (hasConfiguredOperatorRole(member, cfg.botOperatorRoleIds)) {
      return {
        allowed: true,
        code: OK_CODE,
        reason: null,
        member,
        via: 'operator_role',
      };
    }

    return {
      allowed: false,
      code: MISSING_PERMISSION_CODE,
      reason: 'missing_permission',
      member,
      via: null,
    };
  }

  return {
    authorize,
  };
}

const defaultService = {
  authorize(interaction) {
    return createOperationalAuthorizationService().authorize(interaction);
  },
};

defaultService.createOperationalAuthorizationService = createOperationalAuthorizationService;
defaultService.fetchGuildMember = fetchGuildMember;
defaultService.codes = {
  OK: OK_CODE,
  MISSING_PERMISSION: MISSING_PERMISSION_CODE,
  MEMBER_UNAVAILABLE: MEMBER_UNAVAILABLE_CODE,
  GUILD_UNAVAILABLE: GUILD_UNAVAILABLE_CODE,
};

module.exports = defaultService;