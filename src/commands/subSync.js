const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const subscriberRoleSyncService = require('../services/subscriberRoleSyncService');

function mapAction(action) {
  if (action === 'role_added') {
    return 'cargo adicionado';
  }

  if (action === 'role_removed') {
    return 'cargo removido';
  }

  if (action === 'already_correct') {
    return 'já estava correto';
  }

  return 'não alterado';
}

function mapResult(result) {
  const dictionary = {
    role_added: 'Cargo adicionado com sucesso.',
    role_removed: 'Cargo removido com sucesso.',
    already_present: 'O usuário já possuía o cargo.',
    already_absent: 'O usuário já não possuía o cargo.',
    guild_not_found: 'Servidor configurado não foi encontrado.',
    role_not_found: 'Cargo configurado não foi encontrado.',
    member_not_found: 'Membro não encontrado no servidor.',
    missing_manage_roles: 'O bot não possui permissão ManageRoles.',
    role_not_editable: 'O cargo configurado não é editável pelo bot.',
    hierarchy_error: 'Hierarquia de cargos impede a alteração.',
    member_not_manageable: 'O bot não pode gerenciar este membro.',
    discord_api_error: 'A API do Discord retornou erro ao alterar o cargo.',
    eligibility_unavailable: 'Elegibilidade indisponível no momento; cargo não alterado.',
    eligibility_error: 'Falha ao consultar elegibilidade; cargo não alterado.',
    invalid_discord_id: 'Usuário inválido para sincronização.',
  };

  return dictionary[result] || 'Resultado não mapeado.';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sub-sync')
    .setDescription('Sincroniza manualmente o cargo SUB de um usuário com base na elegibilidade atual.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName('usuario')
        .setDescription('Usuário para sincronizar o cargo SUB.')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Motivo desta sincronização manual.')
        .setRequired(true),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Este comando só pode ser usado dentro de um servidor.',
        ephemeral: true,
      });
      return;
    }

    if (config.guildId && interaction.guildId !== config.guildId) {
      await interaction.reply({
        content: 'Este comando só pode ser usado no servidor configurado para o bot.',
        ephemeral: true,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: 'Você precisa da permissão de Administrator para usar este comando.',
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser('usuario', true);
    const reason = interaction.options.getString('motivo', true).trim();

    if (!reason) {
      await interaction.reply({
        content: 'O motivo da sincronização é obrigatório.',
        ephemeral: true,
      });
      return;
    }

    if (targetUser.bot) {
      await interaction.reply({
        content: 'Não é permitido sincronizar cargo SUB para bots.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const result = await subscriberRoleSyncService.syncUser(targetUser.id, {
      client: interaction.client,
      triggeredByDiscordId: interaction.user.id,
      triggerType: 'command_sub_sync',
      reason,
    });

    const activeSources = [];
    if (result.sources?.kick) {
      activeSources.push('- Kick');
    }
    if (result.sources?.manual) {
      activeSources.push('- Concessão manual');
    }

    const lines = [
      `Usuário: <@${targetUser.id}>`,
      `Elegibilidade final: ${result.eligibility === true ? 'ativa' : result.eligibility === false ? 'inativa' : 'indisponível'}`,
      'Fontes ativas:',
      activeSources.length ? activeSources.join('\n') : '- nenhuma',
      `Ação: ${mapAction(result.action)}`,
      `Resultado: ${mapResult(result.result)}`,
      `Cargo alvo: ${result.roleName || 'indisponível'}`,
      `Motivo: ${reason}`,
    ];

    if (result.auditWarning === 'audit_failed') {
      lines.push('Auditoria: não foi possível registrar esta tentativa, mas a sincronização do cargo foi preservada.');
    }

    await interaction.editReply(lines.join('\n'));
  },
};
