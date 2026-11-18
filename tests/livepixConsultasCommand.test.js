jest.mock('../src/services/livepixAuthService', () => ({
  getAccessToken: jest.fn(),
  listSubscriptions: jest.fn(),
  listSubscriptionPlans: jest.fn(),
  listSubscriptionTransactions: jest.fn(),
  getEndpointCooldown: jest.fn(),
}));

const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const livepixAuthService = require('../src/services/livepixAuthService');
const command = require('../src/commands/livepixConsultas');

function createInteraction({ isAdmin = true, inGuild = true } = {}) {
  return {
    inGuild: () => inGuild,
    memberPermissions: {
      has: (permission) => permission === PermissionFlagsBits.Administrator && isAdmin,
    },
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue(undefined),
  };
}

function getReplyContent(interaction) {
  const reply = interaction.editReply.mock.calls[0][0];
  return typeof reply === 'string' ? reply : reply.content;
}

describe('/livepix-consultas command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    livepixAuthService.getAccessToken.mockResolvedValue('private-access-token');
    livepixAuthService.listSubscriptions.mockResolvedValue([]);
    livepixAuthService.listSubscriptionPlans.mockResolvedValue([]);
    livepixAuthService.getEndpointCooldown.mockReturnValue(null);
  });

  test('é registrado com permissão padrão de Administrator', () => {
    const data = command.data.toJSON();

    expect(data.name).toBe('livepix-consultas');
    expect(data.default_member_permissions).toBe(
      PermissionFlagsBits.Administrator.toString(),
    );
  });

  test('restringe a execução a Administrators sem chamar a API', async () => {
    const interaction = createInteraction({ isAdmin: false });

    await command.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Você precisa da permissão de Administrator para usar este comando.',
      flags: MessageFlags.Ephemeral,
    });
    expect(livepixAuthService.getAccessToken).not.toHaveBeenCalled();
    expect(livepixAuthService.listSubscriptions).not.toHaveBeenCalled();
    expect(livepixAuthService.listSubscriptionPlans).not.toHaveBeenCalled();
  });

  test('consulta somente a primeira página de assinaturas e planos e exibe contagens seguras', async () => {
    livepixAuthService.listSubscriptions.mockResolvedValue([
      { id: 'sub-1', subscriber: 'private-subscriber-name', status: 'active' },
      { id: 'sub-2', subscriber: 'another-private-name', status: 'active' },
      { id: 'sub-3', subscriber: 'private-subscriber-name', status: 'pending' },
      { id: 'sub-4', subscriber: 'private-subscriber-name', status: 'cancelled' },
    ]);
    livepixAuthService.listSubscriptionPlans.mockResolvedValue([
      { id: 'plan-1', name: 'Private Plan Name', description: 'Private plan details' },
      { id: 'plan-2', name: 'Another Plan', description: 'Private plan details' },
    ]);
    const interaction = createInteraction();

    await command.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(livepixAuthService.getAccessToken).toHaveBeenCalledTimes(1);
    expect(livepixAuthService.listSubscriptions).toHaveBeenCalledWith({ page: 1, limit: 10 });
    expect(livepixAuthService.listSubscriptionPlans).toHaveBeenCalledWith({ page: 1, limit: 10 });
    expect(livepixAuthService.listSubscriptionTransactions).not.toHaveBeenCalled();
    const reply = getReplyContent(interaction);
    expect(reply).toContain('**Autenticação:** ✅ Token obtido.');
    expect(reply).toContain('**Assinaturas:** ✅ 4 itens na página');
    expect(reply).toContain('**Planos:** ✅ 2 itens na página');
    expect(reply).toContain('ativas 2 · pendentes 1 · canceladas 1');
    expect(reply).toContain('somente a primeira página');
    expect(reply).not.toContain('private-access-token');
    expect(reply).not.toContain('private-subscriber-name');
    expect(reply).not.toContain('Private Plan Name');
    expect(reply).not.toContain('Private plan details');
  });

  test.each([
    'Active',
    'active',
    'ACTIVE',
    'Pending',
    'pending',
    'PENDING',
    'Cancelled',
    'cancelled',
    'CANCELLED',
  ])('aceita status %s preservando o valor recebido', async (status) => {
    const subscription = { id: 'sub-1', status };
    livepixAuthService.listSubscriptions.mockResolvedValue([subscription]);
    const interaction = createInteraction();

    await command.execute(interaction);

    const reply = getReplyContent(interaction);
    expect(reply).toContain('**Assinaturas:** ✅ 1 item na página');
    expect(subscription.status).toBe(status);
  });

  test('normaliza status somente para validar e contar sem alterar os valores originais', async () => {
    const subscriptions = [
      { id: 'sub-1', status: 'Active' },
      { id: 'sub-2', status: 'active' },
      { id: 'sub-3', status: 'ACTIVE' },
      { id: 'sub-4', status: 'Pending' },
      { id: 'sub-5', status: 'pending' },
      { id: 'sub-6', status: 'PENDING' },
      { id: 'sub-7', status: 'Cancelled' },
      { id: 'sub-8', status: 'cancelled' },
      { id: 'sub-9', status: 'CANCELLED' },
    ];
    livepixAuthService.listSubscriptions.mockResolvedValue(subscriptions);
    const interaction = createInteraction();

    await command.execute(interaction);

    expect(getReplyContent(interaction)).toContain(
      '**Status nesta página:** ativas 3 · pendentes 3 · canceladas 3',
    );
    expect(subscriptions.map((subscription) => subscription.status)).toEqual([
      'Active',
      'active',
      'ACTIVE',
      'Pending',
      'pending',
      'PENDING',
      'Cancelled',
      'cancelled',
      'CANCELLED',
    ]);
  });

  test.each([
    ['desconhecido', { status: 'expired' }],
    ['ausente', {}],
    ['null', { status: null }],
    ['number', { status: 1 }],
    ['boolean', { status: true }],
    ['object', { status: {} }],
  ])('rejeita status %s com diagnóstico de validação do comando', async (_label, statusField) => {
    livepixAuthService.listSubscriptions.mockResolvedValue([
      { id: 'sub-1', ...statusField },
    ]);
    const interaction = createInteraction();

    await command.execute(interaction);

    expect(getReplyContent(interaction)).toContain(
      '**Assinaturas:** ❌ Falha — A validação adicional do comando rejeitou a resposta de assinaturas.',
    );
  });

  test.each([
    ['ausente', { status: 'active' }],
    ['vazio', { id: '', status: 'active' }],
    ['null', { id: null, status: 'active' }],
    ['number', { id: 1, status: 'active' }],
  ])('continua rejeitando ID %s', async (_label, subscription) => {
    livepixAuthService.listSubscriptions.mockResolvedValue([subscription]);
    const interaction = createInteraction();

    await command.execute(interaction);

    expect(getReplyContent(interaction)).toContain(
      '**Assinaturas:** ❌ Falha — A validação adicional do comando rejeitou a resposta de assinaturas.',
    );
  });

  test('exibe falha das assinaturas sem ocultar o sucesso dos planos', async () => {
    livepixAuthService.listSubscriptions.mockRejectedValue(
      Object.assign(new Error('private response body'), { code: 'FORBIDDEN' }),
    );
    livepixAuthService.listSubscriptionPlans.mockResolvedValue([{ id: 'plan-1', name: 'Plan' }]);
    const interaction = createInteraction();

    await command.execute(interaction);

    const reply = getReplyContent(interaction);
    expect(reply).toContain('**Assinaturas:** ❌ Falha — HTTP 403: acesso proibido pela LivePix.');
    expect(reply).toContain('**Planos:** ✅ 1 item na página');
    expect(reply).not.toContain('private response body');
  });

  test('exibe falha dos planos sem ocultar o sucesso das assinaturas', async () => {
    livepixAuthService.listSubscriptions.mockResolvedValue([
      { id: 'sub-1', status: 'active' },
    ]);
    livepixAuthService.listSubscriptionPlans.mockRejectedValue(
      Object.assign(new Error('private upstream body'), { code: 'REQUEST_TIMEOUT' }),
    );
    const interaction = createInteraction();

    await command.execute(interaction);

    const reply = getReplyContent(interaction);
    expect(reply).toContain('**Assinaturas:** ✅ 1 item na página');
    expect(reply).toContain('**Planos:** ❌ Falha — Tempo limite excedido');
    expect(reply).not.toContain('private upstream body');
  });

  test('informa cooldown por endpoint, mostra reset e não chama endpoint bloqueado', async () => {
    const resetAt = Date.now() + 60_000;
    livepixAuthService.getEndpointCooldown.mockImplementation((endpoint) =>
      endpoint === '/v2/subscriptions' ? resetAt : null,
    );
    livepixAuthService.listSubscriptionPlans.mockResolvedValue([{ id: 'plan-1', name: 'Plan' }]);
    const interaction = createInteraction();

    await command.execute(interaction);

    const reply = getReplyContent(interaction);
    expect(reply).toContain(
      `**Assinaturas:** ❌ Falha — HTTP 429: limite de requisições atingido. Consulta disponível após <t:${Math.floor(resetAt / 1000)}:F>.`,
    );
    expect(reply).toContain('**Planos:** ✅ 1 item na página');
    expect(livepixAuthService.listSubscriptions).not.toHaveBeenCalled();
    expect(livepixAuthService.listSubscriptionPlans).toHaveBeenCalledTimes(1);
  });

  test('mostra o horário de reset recebido no erro de rate limit', async () => {
    const resetAt = Date.now() + 120_000;
    livepixAuthService.listSubscriptions.mockRejectedValue(
      Object.assign(new Error('private response body'), {
        code: 'RATE_LIMITED',
        cooldownUntil: resetAt,
      }),
    );
    const interaction = createInteraction();

    await command.execute(interaction);

    expect(getReplyContent(interaction)).toContain(
      `Consulta disponível após <t:${Math.floor(resetAt / 1000)}:F>.`,
    );
  });

  test('não executa consultas se a autenticação falhar', async () => {
    livepixAuthService.getAccessToken.mockRejectedValue(
      Object.assign(new Error('client-secret private-token'), { code: 'UNAUTHORIZED' }),
    );
    const interaction = createInteraction();

    await command.execute(interaction);

    const reply = getReplyContent(interaction);
    expect(reply).toContain('**Autenticação:** ❌ Falha — HTTP 401: autenticação LivePix recusada.');
    expect(reply).toContain('**Assinaturas:** não consultadas');
    expect(reply).toContain('**Planos:** não consultados');
    expect(livepixAuthService.listSubscriptions).not.toHaveBeenCalled();
    expect(livepixAuthService.listSubscriptionPlans).not.toHaveBeenCalled();
    expect(reply).not.toContain('client-secret');
    expect(reply).not.toContain('private-token');
  });

  test('trata respostas incompletas ou malformadas como falha segura por endpoint', async () => {
    livepixAuthService.listSubscriptions.mockResolvedValue({ data: [] });
    livepixAuthService.listSubscriptionPlans.mockResolvedValue([{}]);
    const interaction = createInteraction();

    await command.execute(interaction);

    const reply = getReplyContent(interaction);
    expect(reply).toContain(
      '**Assinaturas:** ❌ Falha — A validação adicional do comando rejeitou a resposta de assinaturas.',
    );
    expect(reply).toContain(
      '**Planos:** ❌ Falha — A validação adicional do comando rejeitou a resposta de planos.',
    );
    expect(reply).not.toContain('[object Object]');
  });

  test.each([
    ['UNAUTHORIZED', 'HTTP 401: token inválido/expirado ou escopo não autorizado.'],
    ['FORBIDDEN', 'HTTP 403: acesso proibido pela LivePix.'],
    ['RATE_LIMITED', 'HTTP 429: limite de requisições atingido.'],
    ['REQUEST_TIMEOUT', 'Tempo limite excedido ao consultar a LivePix.'],
    ['NETWORK_ERROR', 'Falha de rede ao consultar a LivePix.'],
    [
      'INVALID_SUBSCRIPTIONS_RESPONSE',
      'O serviço LivePix rejeitou a resposta de assinaturas.',
    ],
  ])('apresenta mensagem segura para %s', async (code, expectedMessage) => {
    livepixAuthService.listSubscriptions.mockRejectedValue(
      Object.assign(new Error('sensitive response content'), { code }),
    );
    const interaction = createInteraction();

    await command.execute(interaction);

    const reply = getReplyContent(interaction);
    expect(reply).toContain(expectedMessage);
    expect(reply).not.toContain('sensitive response content');
  });
});
