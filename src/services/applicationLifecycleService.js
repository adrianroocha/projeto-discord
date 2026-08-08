function createApplicationLifecycleService() {
  let state = 'starting';
  let reason = null;
  let startedAtMs = Date.now();
  let updatedAtMs = startedAtMs;

  function setState(nextState, nextReason = null) {
    state = nextState;
    reason = typeof nextReason === 'string' && nextReason.trim() ? nextReason.trim() : null;
    updatedAtMs = Date.now();
  }

  function markReady() {
    if (state === 'ready') {
      return { changed: false, state };
    }

    setState('ready');
    return { changed: true, state };
  }

  function markFailed(failureReason) {
    setState('failed', failureReason || 'startup_failure');
    return {
      changed: true,
      state,
      reason,
      updatedAtMs,
    };
  }

  function beginShutdown(shutdownReason) {
    if (state === 'shutting_down') {
      return {
        startedNow: false,
        state,
        reason,
        startedAtMs,
        updatedAtMs,
      };
    }

    setState('shutting_down', shutdownReason || 'shutdown');

    return {
      startedNow: true,
      state,
      reason,
      startedAtMs,
      updatedAtMs,
    };
  }

  function markStopped(stopReason) {
    setState('stopped', stopReason || reason || 'shutdown_complete');
    return {
      state,
      reason,
      startedAtMs,
      updatedAtMs,
    };
  }

  function isShuttingDown() {
    return state === 'shutting_down';
  }

  function isReady() {
    return state === 'ready';
  }

  function getState() {
    return {
      state,
      reason,
      startedAtMs,
      updatedAtMs,
    };
  }

  function _resetForTests() {
    state = 'starting';
    reason = null;
    startedAtMs = Date.now();
    updatedAtMs = startedAtMs;
  }

  return {
    markReady,
    markFailed,
    beginShutdown,
    markStopped,
    isShuttingDown,
    isReady,
    getState,
    _resetForTests,
  };
}

const defaultService = createApplicationLifecycleService();
defaultService.createApplicationLifecycleService = createApplicationLifecycleService;

module.exports = defaultService;
