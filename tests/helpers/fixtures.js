function makeQueueEntry(overrides = {}) {
  return {
    id: overrides.id || null,
    discordId: overrides.discordId || 'user-1',
    username: overrides.username || 'User#0001',
    displayName: overrides.displayName || 'User 1',
    isSubscriber: overrides.isSubscriber ? 1 : 0,
    joinedAtMs: overrides.joinedAtMs || Date.now(),
  };
}

function makeLobby(overrides = {}) {
  return {
    id: overrides.id || 1,
    lobbyNumber: overrides.lobbyNumber || 1,
    status: overrides.status || 'forming',
    creationType: overrides.creationType || 'automatic',
    createdAtMs: overrides.createdAtMs || Date.now(),
  };
}

function makeLobbyPlayer(overrides = {}) {
  return {
    id: overrides.id || 1,
    lobbyId: overrides.lobbyId || 1,
    discordId: overrides.discordId || 'user-1',
    username: overrides.username || 'User#0001',
    displayName: overrides.displayName || 'User 1',
    position: overrides.position || 1,
    originalJoinedAtMs: overrides.originalJoinedAtMs || Date.now(),
    isSubscriber: overrides.isSubscriber ? 1 : 0,
  };
}

function makeQueuePlayers(count, options = {}) {
  const baseTime = options.baseTime || Date.now();
  const subscriberCount = options.subscriberCount || 0;
  const prefix = options.prefix || 'user';
  const startIndex = options.startIndex || 1;

  return Array.from({ length: count }, (_, index) => {
    const position = startIndex + index;
    return {
      discordId: `${prefix}-${String(position).padStart(3, '0')}`,
      username: `Player ${String(position).padStart(2, '0')}#0001`,
      displayName: `Player ${String(position).padStart(2, '0')}`,
      isSubscriber: index < subscriberCount ? 1 : 0,
      joinedAtMs: baseTime + index,
    };
  });
}

module.exports = {
  makeQueueEntry,
  makeLobby,
  makeLobbyPlayer,
  makeQueuePlayers,
};
