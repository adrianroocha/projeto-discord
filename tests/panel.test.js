const { createTestContext } = require('./helpers/testDatabase');

let context;
let queueMessageService;

describe('queue panel', () => {
  beforeAll(async () => {
    context = await createTestContext({ nodeEnv: 'test' });
    queueMessageService = require('../src/services/queueMessageService');
  });

  afterAll(async () => {
    await context.cleanup();
  });

  test('mostra estado vazio e aviso de fila aberta', () => {
    const content = queueMessageService.buildPanelContent([], [], { isQueueOpen: true });

    expect(content).toContain('# 🎮 Sistema de Fila');
    expect(content).toContain('⏳ Após entrar na fila, é necessário aguardar 2 minutos antes de poder sair.');
    expect(content).toContain('Nenhum jogador aguardando.');
    expect(content).toContain('Nenhum lobby em formação.');
    expect(content).toContain('Nenhum lobby ativa.');
  });

  test('mostra aviso de fila fechada e sub na formatação atual', () => {
    const content = queueMessageService.buildPanelContent(
      [
        {
          lobbyNumber: 7,
          status: 'forming',
          players: [
            { username: 'Bot-Fubinha', displayName: 'Bot-Fubinha', isSubscriber: true },
            { username: 'Jogador Teste 01', displayName: 'Jogador Teste 01', isSubscriber: false },
          ],
        },
        {
          lobbyNumber: 8,
          status: 'in_game',
          players: [
            { username: 'Jogador Ativo', displayName: 'Jogador Ativo', isSubscriber: false },
          ],
        },
      ],
      [
        { username: 'Aguardando 1', display_name: 'Aguardando 1', is_subscriber: 0 },
      ],
      { isQueueOpen: false },
    );

    expect(content).toContain('🔒 Fila fechada no momento.');
    expect(content).toContain('1. Aguardando 1');
    expect(content).toContain('Lobby #7');
    expect(content).toContain('Bot-Fubinha (Sub)👑');
    expect(content).toContain('Lobby #8');
    expect(content).toContain('Jogador Ativo');
  });

  test('habilita e desabilita o botão de entrada conforme o estado', () => {
    const openRow = queueMessageService.createActionRow(true).toJSON();
    const closedRow = queueMessageService.createActionRow(false).toJSON();

    expect(openRow.components[0].disabled).toBe(false);
    expect(openRow.components[1].disabled).toBe(false);
    expect(closedRow.components[0].disabled).toBe(true);
    expect(closedRow.components[1].disabled).toBe(true);
    expect(openRow.components[0].custom_id).toBe('join_queue');
    expect(openRow.components[1].custom_id).toBe('leave_queue');
  });
});
