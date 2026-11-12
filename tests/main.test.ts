import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/status-bar', () => ({ StatusBar: class { update() {} } }));
vi.mock('../src/ui/settings-tab', () => ({ LANSyncSettingTab: class {} }));
vi.mock('../src/ui/sync-view', () => ({ SyncView: class {} }));
vi.mock('../src/ui/sync-log-view', () => ({ SyncLogView: class {} }));
vi.mock('../src/sync-log/sync-log-service', () => ({
  SyncLogService: class { async loadFromDisk() {} async flush() {} },
}));
vi.mock('../src/conflict/conflict-backup-service', () => ({ ConflictBackupService: class {} }));

import LANSyncPlugin from '../src/main';

(globalThis as any).document ??= { visibilityState: 'visible' };
(globalThis as any).window ??= globalThis;

function createPlugin(layoutReady: Array<() => void> | null = null): LANSyncPlugin {
  const plugin = new (LANSyncPlugin as any)() as LANSyncPlugin;
  const onLayoutReady = (cb: () => void) => (layoutReady ? layoutReady.push(cb) : cb());
  Object.assign(plugin as any, {
    app: { vault: {}, workspace: { onLayoutReady } },
    loadData: async () => ({}),
    saveData: async () => undefined,
    registerView: () => undefined,
    addSettingTab: () => undefined,
    addCommand: () => undefined,
    registerObsidianProtocolHandler: () => undefined,
    domEvents: [] as Array<[unknown, string, () => void]>,
    registerDomEvent(target: unknown, type: string, cb: () => void) {
      (this as any).domEvents.push([target, type, cb]);
    },
  });
  return plugin;
}

describe('plugin lifecycle', () => {
  it('does not start sync when the plugin is unloaded before the start delay', async () => {
    vi.useFakeTimers();
    const plugin = createPlugin();
    const startSync = vi.spyOn(plugin, 'startSync').mockResolvedValue(undefined);
    await plugin.onload();
    await plugin.onunload();
    vi.advanceTimersByTime(5000);
    vi.useRealTimers();
    expect(startSync).not.toHaveBeenCalled();
  });

  it('starts sync only after Obsidian has finished loading the vault', async () => {
    vi.useFakeTimers();
    const ready: Array<() => void> = [];
    const plugin = createPlugin(ready);
    const startSync = vi.spyOn(plugin, 'startSync').mockResolvedValue(undefined);
    await plugin.onload();
    vi.advanceTimersByTime(5000);
    expect(startSync).not.toHaveBeenCalled();
    ready.forEach((cb) => cb());
    vi.advanceTimersByTime(2500);
    vi.useRealTimers();
    expect(startSync).toHaveBeenCalledTimes(1);
  });
});

describe('reconnecting', () => {
  it('retries connections when the app comes back or the network returns', async () => {
    const plugin = createPlugin() as any;
    plugin.loadData = async () => ({ enabled: false });
    await plugin.onload();
    let retries = 0;
    plugin.coordinator = { reconnectNow: () => retries++ };
    const fire = (type: string) => {
      for (const [, t, cb] of plugin.domEvents) if (t === type) cb();
    };
    fire('visibilitychange');
    fire('online');
    expect(retries).toBe(2);
    plugin.coordinator = null;
    await plugin.onunload();
  });
});

describe('settings changes', () => {
  it('restarts a running sync once typing in a setting stops', async () => {
    vi.useFakeTimers();
    try {
      const plugin = createPlugin() as any;
      const startSync = vi.spyOn(plugin, 'startSync').mockResolvedValue(undefined);
      plugin.coordinator = {};
      plugin.restartSyncSoon();
      vi.advanceTimersByTime(500);
      plugin.restartSyncSoon();
      vi.advanceTimersByTime(1000);
      expect(startSync).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(startSync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start sync that is off', async () => {
    vi.useFakeTimers();
    try {
      const plugin = createPlugin() as any;
      const startSync = vi.spyOn(plugin, 'startSync').mockResolvedValue(undefined);
      plugin.coordinator = null;
      plugin.restartSyncSoon();
      vi.advanceTimersByTime(5000);
      expect(startSync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
