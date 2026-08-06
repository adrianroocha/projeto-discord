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

describe('interactionCreate event', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
