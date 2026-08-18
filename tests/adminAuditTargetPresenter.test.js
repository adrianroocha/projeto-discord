const presenter = require('../src/services/adminAuditTargetPresenter');

const USER_A = '123456789012345678';
const USER_B = '987654321098765432';

describe('adminAuditTargetPresenter', () => {
  test('auditoria com um alvo exibe mencao e ID', () => {
    const lines = presenter.buildAuditTargetLines({
      commandName: 'lobby-remove',
      nextState: { targetDiscordId: USER_A, lobbyNumber: 3 },
      parameters: { usuario: USER_A, motivo: 'teste' },
    });

    expect(lines).toEqual([`Alvo: <@${USER_A}>`, `ID do alvo: ${USER_A}`]);
  });

  test('auditoria com dois alvos exibe A e B separadamente com origem e destino', () => {
    const lines = presenter.buildAuditTargetLines({
      commandName: 'lobby-swap',
      nextState: {
        usuarioADiscordId: USER_A,
        usuarioBDiscordId: USER_B,
        origemADetalhe: 'Lobby #3',
        destinoADetalhe: 'Fila',
        origemBDetalhe: 'Fila',
        destinoBDetalhe: 'Lobby #3',
        lobbiesEnvolvidas: [3],
      },
      parameters: { usuario_a: USER_A, usuario_b: USER_B },
    });

    expect(lines[0]).toBe('Alvos:');
    expect(lines[1]).toBe(`Usuário A: <@${USER_A}> — ID: ${USER_A} — origem: Lobby #3 -> destino: Fila`);
    expect(lines[2]).toBe(`Usuário B: <@${USER_B}> — ID: ${USER_B} — origem: Fila -> destino: Lobby #3`);
    expect(lines[3]).toBe('Lobbies envolvidas: #3');
  });

  test('comando sem alvo humano nao gera campo de alvo', () => {
    expect(
      presenter.buildAuditTargetLines({
        commandName: 'lobby-start',
        nextState: { lobbyNumber: 2 },
        parameters: { numero: 2 },
      }),
    ).toEqual([]);

    expect(
      presenter.buildAuditTargetLines({
        commandName: 'scheduler-open',
        nextState: { state: 'open' },
        parameters: {},
      }),
    ).toEqual([]);

    expect(
      presenter.buildAuditTargetLines({
        commandName: 'lobby-form-force',
        nextState: { requestedQuantity: 5, playersUsed: 5 },
        parameters: { quantidade: 5 },
      }),
    ).toEqual([]);
  });

  test('ID invalido e omitido com seguranca', () => {
    const lines = presenter.buildAuditTargetLines({
      commandName: 'lobby-remove',
      nextState: { targetDiscordId: 'nao-e-snowflake' },
      parameters: { usuario: '12' },
    });

    expect(lines).toEqual([]);
    expect(presenter.isDiscordSnowflake('nao-e-snowflake')).toBe(false);
    expect(presenter.isDiscordSnowflake(USER_A)).toBe(true);
  });

  test('registro historico sem alvo persistido nao quebra a apresentacao', () => {
    expect(
      presenter.buildAuditTargetLines({
        commandName: 'lobby-remove',
        nextState: {},
        parameters: {},
      }),
    ).toEqual([]);

    expect(presenter.buildAuditTargetLines({})).toEqual([]);
    expect(presenter.buildAuditTargetLines({ commandName: 'lobby-swap' })).toEqual([]);
  });

  test('campos legados conhecidos continuam sendo reconhecidos', () => {
    const lines = presenter.buildAuditTargetLines({
      commandName: 'lobby-swap',
      nextState: {},
      parameters: { usuario_lobby: USER_A, usuario_fila: USER_B },
    });

    expect(lines[1]).toContain(USER_A);
    expect(lines[2]).toContain(USER_B);
  });

  test('nenhum Kick ID e exibido como alvo', () => {
    const lines = presenter.buildAuditTargetLines({
      commandName: 'kick-status',
      nextState: { kickUserId: '55667788', kickId: '99887766', broadcasterId: '11223344' },
      parameters: { kickUsername: 'streamer' },
    });

    expect(lines).toEqual([]);
  });

  test('nenhum interaction ID, channel ID ou ID interno e exibido como alvo', () => {
    const lines = presenter.buildAuditTargetLines({
      commandName: 'lobby-remove',
      nextState: {
        lobbyId: 42,
        interactionId: '111111111111111111',
        channelId: '222222222222222222',
        auditId: 7,
      },
      parameters: {},
    });

    expect(lines).toEqual([]);
  });

  test('nao produz mencao de cargo nem @everyone', () => {
    const lines = presenter.buildAuditTargetLines({
      commandName: 'lobby-swap',
      nextState: {
        usuarioADiscordId: USER_A,
        usuarioBDiscordId: USER_B,
        origemADetalhe: '@everyone <@&555555555555555555>',
      },
    });

    const content = lines.join('\n');
    expect(content).not.toContain('<@&');
    expect(content).not.toContain('@everyone');
    expect(content.match(/<@\d{17,20}>/g)).toEqual([`<@${USER_A}>`, `<@${USER_B}>`]);
  });

  test('conteudo fornecido pelo usuario nao cria mencao valida adicional', () => {
    const lines = presenter.buildAuditTargetLines({
      commandName: 'lobby-swap',
      nextState: {
        usuarioADiscordId: USER_A,
        usuarioBDiscordId: USER_B,
        origemADetalhe: 'texto <@999999999999999999> injetado',
      },
    });

    expect(lines[1]).toContain('origem: texto 999999999999999999 injetado');
    expect(lines.join('\n').match(/<@\d{17,20}>/g)).toEqual([`<@${USER_A}>`, `<@${USER_B}>`]);
  });

  test('mensagem permanece dentro do limite do Discord', () => {
    const oversized = `${'a'.repeat(3000)}`;
    const capped = presenter.capDiscordContent(oversized);

    expect(capped.length).toBe(presenter.DISCORD_CONTENT_LIMIT);
    expect(presenter.capDiscordContent('curto')).toBe('curto');
  });

  test('origem e destino sao truncados e sem quebras de linha', () => {
    const lines = presenter.buildAuditTargetLines({
      commandName: 'lobby-swap',
      nextState: {
        usuarioADiscordId: USER_A,
        usuarioBDiscordId: USER_B,
        origemADetalhe: `Lobby\n\n${'x'.repeat(200)}`,
      },
    });

    expect(lines[1]).not.toContain('\n');
    expect(lines[1].length).toBeLessThan(200);
  });

  test('extractAuditTargets retorna contrato canonico com papel explicito', () => {
    const targets = presenter.extractAuditTargets({
      commandName: 'lobby-swap',
      nextState: { usuarioADiscordId: USER_A, usuarioBDiscordId: USER_B },
    });

    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ type: 'discord_user', role: 'user_a', discordId: USER_A });
    expect(targets[1]).toMatchObject({ type: 'discord_user', role: 'user_b', discordId: USER_B });
  });
});
