const { createApplicationLifecycleService } = require('../src/services/applicationLifecycleService');

describe('applicationLifecycleService states', () => {
  test('inicia em starting e vai para ready', () => {
    const lifecycle = createApplicationLifecycleService();

    expect(lifecycle.getState().state).toBe('starting');
    lifecycle.markReady();
    expect(lifecycle.isReady()).toBe(true);
    expect(lifecycle.getState().state).toBe('ready');
  });

  test('transiciona para shutting_down e depois stopped', () => {
    const lifecycle = createApplicationLifecycleService();

    lifecycle.markReady();
    lifecycle.beginShutdown('SIGTERM');
    expect(lifecycle.getState().state).toBe('shutting_down');
    expect(lifecycle.isShuttingDown()).toBe(true);

    lifecycle.markStopped('shutdown_complete');
    expect(lifecycle.getState().state).toBe('stopped');
    expect(lifecycle.isShuttingDown()).toBe(false);
  });

  test('suporta estado failed', () => {
    const lifecycle = createApplicationLifecycleService();

    lifecycle.markFailed('startup_failure');
    const state = lifecycle.getState();

    expect(state.state).toBe('failed');
    expect(state.reason).toBe('startup_failure');
    expect(lifecycle.isReady()).toBe(false);
  });
});
