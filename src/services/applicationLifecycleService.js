function createApplicationLifecycleService() {
  let shuttingDown = false;
  let shutdownReason = null;
  let shutdownStartedAtMs = null;

  function beginShutdown(reason) {
    if (shuttingDown) {
      return {
        startedNow: false,
        shuttingDown,
        reason: shutdownReason,
        startedAtMs: shutdownStartedAtMs,
      };
    }

    shuttingDown = true;
    shutdownReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'shutdown';
    shutdownStartedAtMs = Date.now();

    return {
      startedNow: true,
      shuttingDown,
      reason: shutdownReason,
      startedAtMs: shutdownStartedAtMs,
    };
  }

  function isShuttingDown() {
    return shuttingDown;
  }

  function getState() {
    return {
      shuttingDown,
      reason: shutdownReason,
      startedAtMs: shutdownStartedAtMs,
    };
  }

  function _resetForTests() {
    shuttingDown = false;
    shutdownReason = null;
    shutdownStartedAtMs = null;
  }

  return {
    beginShutdown,
    isShuttingDown,
    getState,
    _resetForTests,
  };
}

const defaultService = createApplicationLifecycleService();
defaultService.createApplicationLifecycleService = createApplicationLifecycleService;

module.exports = defaultService;
