jest.mock('../src/config', () => ({ guildId: 'guild-1' }));
jest.mock('../src/database/livepixAccountsRepository', () => ({
  findByDiscordId: jest.fn(),
  unlinkByDiscordId: jest.fn(),
}));
jest.mock('../src/services/livepixUnlinkConfirmationService', () => ({
  create: jest.fn(),
  consume: jest.fn(),
  invalidate: jest.fn(),
}));

const repository = require('../src/database/livepixAccountsRepository');
const confirmation = require('../src/services/livepixUnlinkConfirmationService');
const startButton = require('../src/buttons/livepixUnlinkStart');
const confirmButton = require('../src/buttons/livepixUnlinkConfirm');
const cancelButton = require('../src/buttons/livepixUnlinkCancel');

describe('botões de desvinculação LivePix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('solicita confirmação privada antes de remover vínculo', async () => {
    repository.findByDiscordId.mockReturnValue({ livepix_account_id: 'account-1' });
    confirmation.create.mockReturnValue({ token: 'confirm-token' });
    const interaction = {
      inGuild: () => true,
      guildId: 'guild-1',
      user: { id: 'discord-1' },
      reply: jest.fn(),
    };

    await startButton.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: expect.any(Number),
        content: expect.stringContaining('O vínculo Kick não será alterado'),
      }),
    );
    expect(confirmation.create).toHaveBeenCalledWith('discord-1');
    expect(repository.unlinkByDiscordId).not.toHaveBeenCalled();
  });

  test('confirma a remoção e desativa botões de uso único', async () => {
    confirmation.consume.mockReturnValue({ ok: true });
    repository.unlinkByDiscordId.mockReturnValue(true);
    const interaction = {
      customId: 'livepix-unlink-confirm:confirm-token',
      user: { id: 'discord-1' },
      update: jest.fn(),
    };

    await confirmButton.execute(interaction);

    expect(repository.unlinkByDiscordId).toHaveBeenCalledWith('discord-1');
    expect(interaction.update.mock.calls[0][0].content).toContain('O vínculo Kick não foi alterado');
    expect(interaction.update.mock.calls[0][0].components[0].toJSON().components.every((button) => button.disabled)).toBe(
      true,
    );
  });

  test('cancelamento invalida confirmação e não remove vínculo', async () => {
    confirmation.invalidate.mockReturnValue(true);
    const interaction = {
      customId: 'livepix-unlink-cancel:confirm-token',
      user: { id: 'discord-1' },
      update: jest.fn(),
    };

    await cancelButton.execute(interaction);

    expect(confirmation.invalidate).toHaveBeenCalledWith('confirm-token', 'discord-1');
    expect(interaction.update.mock.calls[0][0].content).toContain('cancelada');
    expect(repository.unlinkByDiscordId).not.toHaveBeenCalled();
  });
});
