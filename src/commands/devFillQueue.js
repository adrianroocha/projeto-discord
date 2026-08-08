const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const queueService = require('../services/queueService');
const config = require('../config');
const { getDatabase } = require('../database/sqliteClient');

function getNextTestUserIndex() {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT discord_id FROM queue_entries WHERE discord_id LIKE 'test-user-%' UNION SELECT discord_id FROM lobby_players WHERE discord_id LIKE 'test-user-%'`,
    )
    .all();

  let maxIndex = 0;
  const regex = /^test-user-(\d{3})$/;

  for (const row of rows) {
    const match = regex.exec(row.discord_id);
    if (match) {
      const value = Number(match[1]);
      if (!Number.isNaN(value) && value > maxIndex) {
        maxIndex = value;
      }
    }
  }

  return maxIndex + 1;
}

module.exports = {
  developmentOnly: true,
  data: new SlashCommandBuilder()
    .setName('dev-fill-queue')
    .setDescription('Preenche a fila com jogadores fictícios (apenas em desenvolvimento).')
    .addIntegerOption((option) =>
      option
        .setName('quantidade')
        .setDescription('Quantidade de jogadores a criar (1-50)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(50),
    )
    .addIntegerOption((option) =>
      option
        .setName('subs')
        .setDescription('Quantidade de subscribers entre os jogadores')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(50),
    ),

  async execute(interaction) {
    if (config.nodeEnv !== 'development') {
      await interaction.reply({
        content: 'Este comando está disponível apenas em ambiente de desenvolvimento.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const member = interaction.member;
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && !member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        content: 'Você precisa ser Administrador ou ter permissão de Gerenciar Servidor para usar este comando.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const quantidade = interaction.options.getInteger('quantidade');
    const subs = interaction.options.getInteger('subs') ?? 0;

    if (subs > quantidade) {
      await interaction.reply({
        content: 'O número de subs não pode ser maior que a quantidade total.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const startIndex = getNextTestUserIndex();
    const players = [];
    const baseTime = Date.now();

    for (let i = 0; i < quantidade; i += 1) {
      const index = startIndex + i;
      const id = `test-user-${String(index).padStart(3, '0')}`;
      const name = `Jogador Teste ${String(index).padStart(2, '0')}`;
      players.push({
        discordId: id,
        username: name,
        displayName: name,
        isSubscriber: i < subs ? 1 : 0,
        joinedAtMs: baseTime + i,
      });
    }

    try {
      queueService.addMultipleToQueue(players);
      await interaction.reply({
        content: `✅ ${quantidade} jogadores de teste criados com sucesso (${subs} subs).`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.error('Erro ao preencher a fila de teste:', error);
      await interaction.reply({
        content: 'Houve um erro ao criar os jogadores de teste.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
