jest.mock('../src/buttons/joinQueue', () => ({
  customId: 'join_queue',
  execute: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/buttons/leaveQueue', () => ({
  customId: 'leave_queue',
  execute: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/buttons/kickLinkStart', () => ({
  customId: 'kick-link-start',
  execute: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/buttons/kickUnlinkConfirm', () => ({
  customIdPrefix: 'kick-unlink-confirm:',
  execute: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/buttons/kickUnlinkCancel', () => ({
  customIdPrefix: 'kick-unlink-cancel:',
  execute: jest.fn().mockResolvedValue(undefined),
}));

const joinQueueButton = require('../src/buttons/joinQueue');
const leaveQueueButton = require('../src/buttons/leaveQueue');
const kickLinkStartButton = require('../src/buttons/kickLinkStart');
const kickUnlinkConfirmButton = require('../src/buttons/kickUnlinkConfirm');
const kickUnlinkCancelButton = require('../src/buttons/kickUnlinkCancel');
const interactionCreateEvent = require('../src/events/interactionCreate');
const lifecycleService = require('../src/services/applicationLifecycleService');

describe('interactionCreate event', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lifecycleService._resetForTests();
  });

  afterEach(() => {
    lifecycleService._resetForTests();
  });

  test('recusa interação durante shutdown com resposta ephemeral', async () => {
    lifecycleService.beginShutdown('SIGTERM');

    const interaction = {
      isButton: () => false,
      isChatInputCommand: () => true,
      commandName: 'status',
      client: {
        commands: new Map(),
      },
      replied: false,
      deferred: false,
      reply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
    };

    await interactionCreateEvent.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining('O bot está reiniciando'),
      }),
    );
  });

  test('encaminha botões existentes da fila corretamente', async () => {
    const interaction = {
      isButton: () => true,
      isChatInputCommand: () => false,
      customId: 'join_queue',
      reply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
    };

    await interactionCreateEvent.execute(interaction);

    expect(joinQueueButton.execute).toHaveBeenCalledWith(interaction);
    expect(leaveQueueButton.execute).not.toHaveBeenCalled();
  });

  test('encaminha botão de confirmação kick-unlink por prefixo', async () => {
    const interaction = {
      isButton: () => true,
      isChatInputCommand: () => false,
      customId: 'kick-unlink-confirm:token-123',
      reply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
    };

    await interactionCreateEvent.execute(interaction);

    expect(kickUnlinkConfirmButton.execute).toHaveBeenCalledWith(interaction);
    expect(kickUnlinkCancelButton.execute).not.toHaveBeenCalled();
  });

  test('encaminha botão kick-link-start por custom id exato', async () => {
    const interaction = {
      isButton: () => true,
      isChatInputCommand: () => false,
      customId: 'kick-link-start',
      reply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
    };

    await interactionCreateEvent.execute(interaction);

    expect(kickLinkStartButton.execute).toHaveBeenCalledWith(interaction);
    expect(joinQueueButton.execute).not.toHaveBeenCalled();
    expect(leaveQueueButton.execute).not.toHaveBeenCalled();
    expect(kickUnlinkConfirmButton.execute).not.toHaveBeenCalled();
    expect(kickUnlinkCancelButton.execute).not.toHaveBeenCalled();
  });

  test('encaminha botão de cancelamento kick-unlink por prefixo', async () => {
    const interaction = {
      isButton: () => true,
      isChatInputCommand: () => false,
      customId: 'kick-unlink-cancel:token-123',
      reply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
    };

    await interactionCreateEvent.execute(interaction);

    expect(kickUnlinkCancelButton.execute).toHaveBeenCalledWith(interaction);
    expect(kickUnlinkConfirmButton.execute).not.toHaveBeenCalled();
  });

  test('ignora botão desconhecido sem afetar handlers existentes', async () => {
    const interaction = {
      isButton: () => true,
      isChatInputCommand: () => false,
      customId: 'unknown-button',
      reply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
    };

    await interactionCreateEvent.execute(interaction);

    expect(joinQueueButton.execute).not.toHaveBeenCalled();
    expect(leaveQueueButton.execute).not.toHaveBeenCalled();
    expect(kickUnlinkConfirmButton.execute).not.toHaveBeenCalled();
    expect(kickUnlinkCancelButton.execute).not.toHaveBeenCalled();
  });

  test('recusa interação legada de /fila-add-teste quando comando não está registrado', async () => {
    const interaction = {
      isButton: () => false,
      isChatInputCommand: () => true,
      commandName: 'fila-add-teste',
      client: {
        commands: new Map(),
      },
      replied: false,
      deferred: false,
      reply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
    };

    await interactionCreateEvent.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining('Ferramenta de desenvolvimento'),
      }),
    );
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  test('recusa interação legada de /dev-fill-queue quando comando não está registrado', async () => {
    const interaction = {
      isButton: () => false,
      isChatInputCommand: () => true,
      commandName: 'dev-fill-queue',
      client: {
        commands: new Map(),
      },
      replied: false,
      deferred: false,
      reply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
    };

    await interactionCreateEvent.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining('Ferramenta de desenvolvimento'),
      }),
    );
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  test('recusa interação legada de /dev-clear-test-data quando comando não está registrado', async () => {
    const interaction = {
      isButton: () => false,
      isChatInputCommand: () => true,
      commandName: 'dev-clear-test-data',
      client: {
        commands: new Map(),
      },
      replied: false,
      deferred: false,
      reply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
    };

    await interactionCreateEvent.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining('Ferramenta de desenvolvimento'),
      }),
    );
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
