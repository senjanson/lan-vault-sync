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
