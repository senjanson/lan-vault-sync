import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/status-bar', () => ({ StatusBar: class { update() {} } }));
vi.mock('../src/ui/settings-tab', () => ({ LANSyncSettingTab: class {} }));
vi.mock('../src/ui/sync-view', () => ({ SyncView: class {} }));
vi.mock('../src/ui/sync-log-view', () => ({ SyncLogView: class {} }));
vi.mock('../src/sync-log/sync-log-service', () => ({
  SyncLogService: class { async loadFromDisk() {} async flush() {} setVersionStore() {} },
}));
// Just what startSync wires up, with the real health monitor and log.
vi.mock('../src/sync/sync-coordinator', async () => {
  const { HealthMonitor } = await import('../src/diagnostics/health');
  const { EventLog } = await import('../src/diagnostics/event-log');
  class SyncCoordinator {
    static last: any = null;
    eventLog = new EventLog(null);
    health = new HealthMonitor();
    versionStore: unknown = SyncCoordinator.nextStore;
    static nextStore: unknown = null;
    heldCb: ((held: unknown[]) => void) | null = null;
    constructor() {
      this.health.watch(this.eventLog);
      SyncCoordinator.last = this;
    }
    onHeldDeletionsChange(cb: (held: unknown[]) => void) { this.heldCb = cb; }
    onStateChange() {}
    onDuplicateDevice() {}
    onAuthFailed() {}
    onUnsyncableFile() {}
    onSyncEvent() {}
    async start() {}
    getStartError() { return null; }
    async stop() {}
    async persist() {}
    getState() { return 'watching'; }
    getConnectedPeers() { return []; }
    getUnreachablePeers() { return []; }
    getHeldDeletions() { return []; }
  }
  return { SyncCoordinator };
});
vi.mock('../src/conflict/conflict-backup-service', () => ({ ConflictBackupService: class {} }));

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Notice: class { constructor(message: string) { notices.push(message); } hide() {} },
}));

import LANSyncPlugin from '../src/main';
import { SyncCoordinator } from '../src/sync/sync-coordinator';
import { RECOVERY_VIEW_TYPE } from '../src/history/recovery-view';

(globalThis as any).document ??= { visibilityState: 'visible' };
(globalThis as any).window ??= globalThis;

function createPlugin(layoutReady: Array<() => void> | null = null): LANSyncPlugin {
  const plugin = new (LANSyncPlugin as any)() as LANSyncPlugin;
  const onLayoutReady = (cb: () => void) => (layoutReady ? layoutReady.push(cb) : cb());
  Object.assign(plugin as any, {
    app: {
      vault: {
        configDir: '.obsidian',
        on(name: string, cb: (...args: any[]) => void) {
          (plugin as any).vaultEvents.push([name, cb]);
          return {};
        },
      },
      workspace: { onLayoutReady, on: () => ({}), getLeavesOfType: () => [] },
    },
    loadData: async () => ({}),
    saveData: async () => undefined,
    vaultEvents: [] as Array<[string, (...args: any[]) => void]>,
    views: new Map<string, (leaf: unknown) => any>(),
    registerView(type: string, make: (leaf: unknown) => any) {
      (this as any).views.set(type, make);
    },
    addSettingTab: () => undefined,
    addCommand: () => undefined,
    registerObsidianProtocolHandler: () => undefined,
    registerEvent: () => undefined,
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

const noHealth = { peers: () => [], alerts: () => [], summary: () => ({ consistent: 0, unsynced: 0 }) };

describe('sync status', () => {
  const device = (name: string) => ({ deviceId: name, deviceName: name, ip: '10.0.0.2', port: 50000, vaultId: 'v', lastSeen: 0 });

  it('reads the state and the connected devices from the running sync', () => {
    const plugin = createPlugin() as any;
    expect(plugin.getSyncStatus()).toEqual({ state: 'idle', devices: [], unreachable: [], held: [], health: [], alerts: [], summary: undefined });
    plugin.coordinator = {
      getState: () => 'watching',
      getConnectedPeers: () => [device('mac'), device('iphone'), device('pixel')],
      getUnreachablePeers: () => [],
      getHeldDeletions: () => [],
      health: noHealth,
    };
    const status = plugin.getSyncStatus();
    expect(status.state).toBe('watching');
    expect(status.devices.map((d: { deviceName: string }) => d.deviceName)).toEqual(['mac', 'iphone', 'pixel']);
  });

  it('tells once per stretch of failures that a device cannot be reached', () => {
    const plugin = createPlugin() as any;
    let unreachable: string[] = [];
    const shown: string[][] = [];
    plugin.statusBar = { update: (_s: string, _n: number, u: string[]) => shown.push(u) };
    plugin.coordinator = { getState: () => 'watching', getConnectedPeers: () => [], getUnreachablePeers: () => unreachable, getHeldDeletions: () => [], health: noHealth };
    notices.length = 0;

    unreachable = ['192.168.1.5:50000'];
    plugin.showStatus();
    plugin.showStatus();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('192.168.1.5:50000');
    expect(shown[shown.length - 1]).toEqual(['192.168.1.5:50000']);

    // It connected, then failed again: a new stretch.
    unreachable = [];
    plugin.showStatus();
    expect(shown[shown.length - 1]).toEqual([]);
    unreachable = ['192.168.1.5:50000'];
    plugin.showStatus();
    expect(notices).toHaveLength(2);
  });
});

describe('refusals', () => {
  it('tells once per device, whichever way the connection went', () => {
    const plugin = createPlugin() as any;
    notices.length = 0;
    plugin.notifyAuthFailure({ deviceId: 'macb', deviceName: 'macB', address: '10.0.0.2', reason: 'outdated' });
    plugin.notifyAuthFailure({ deviceId: 'macb', deviceName: 'macB', address: '10.0.0.2:50000', reason: 'outdated' });
    expect(notices).toEqual([expect.stringContaining('macB runs an older version')]);
  });

  it('says when a device syncs another vault, and how to pair it again', () => {
    const plugin = createPlugin() as any;
    notices.length = 0;
    plugin.notifyAuthFailure({ deviceId: 'pixel', deviceName: 'Pixel', address: '10.0.0.3', reason: 'vault-mismatch' });
    plugin.notifyAuthFailure({ deviceId: 'pixel', deviceName: 'Pixel', address: '10.0.0.3:50000', reason: 'vault-mismatch' });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Pixel');
    expect(notices[0]).toContain('another vault');
    expect(notices[0]).toContain('QR code');
  });
});

describe('alerts and the running sync', () => {
  async function started() {
    const plugin = createPlugin() as any;
    plugin.loadData = async () => ({ enabled: false });
    await plugin.onload();
    await plugin.startSync();
    const c = (SyncCoordinator as any).last;
    const fire = (name: string, ...args: unknown[]) => {
      for (const [n, cb] of plugin.vaultEvents) if (n === name) cb(...args);
    };
    return { plugin, c, fire };
  }

  it('clears the held-deletion alert once nothing is held', async () => {
    const { plugin, c } = await started();
    c.eventLog.record({ op: 'held', level: 'warn', batch: 'b1', rule: 'bulk-delete' });
    c.heldCb([{ id: 'b1', kind: 'incoming', paths: ['a.md'] }]);
    expect(c.health.alerts().map((a: { kind: string }) => a.kind)).toEqual(['bulk-held']);
    c.heldCb([]);
    expect(c.health.alerts()).toEqual([]);
    await plugin.onunload();
  });

  it('clears a failed write once the file is written, and a failed keep once the file is gone', async () => {
    const { plugin, c, fire } = await started();
    c.eventLog.record({ op: 'error', level: 'error', path: 'x.png', error: 'EACCES', msg: 'write failed' });
    c.eventLog.record({ op: 'error', level: 'error', path: 'y.png', msg: 'remote-file-delete: could not keep the old version; nothing was changed' });
    c.eventLog.record({ op: 'error', level: 'error', path: 'z.png', msg: 'remote-file-delete: could not keep the old version; nothing was changed' });
    fire('create', { path: 'x.png' });
    fire('delete', { path: 'y.png' });
    fire('rename', { path: 'moved.png' }, 'z.png');
    expect(c.health.alerts()).toEqual([]);
    await plugin.onunload();
  });

  it('shows the recovery center once sync has made the version store', async () => {
    const plugin = createPlugin() as any;
    plugin.loadData = async () => ({ enabled: false });
    await plugin.onload();
    const view = plugin.views.get(RECOVERY_VIEW_TYPE)({});
    const content = { children: [] as any[], text: '', empty() { this.children = []; } } as any;
    const el = (text = ''): any => ({
      text, children: [] as any[], empty() { this.children = []; },
      createEl(_t: string, o?: { text?: string }) { const c = el(o?.text); this.children.push(c); return c; },
      createDiv(o?: { text?: string }) { return this.createEl('div', o); },
      createSpan(o?: { text?: string }) { return this.createEl('span', o); },
    });
    Object.assign(content, el());
    const all = (e: any): string => [e.text, ...e.children.map(all)].join(' ');
    view.containerEl = { children: [el(), content] };
    await view.onOpen();
    expect(all(content)).toContain('not ready');
    (SyncCoordinator as any).nextStore = { groups: async () => [] };
    try {
      await plugin.startSync();
      await vi.waitFor(() => expect(all(content)).toContain('No versions kept yet'));
    } finally {
      (SyncCoordinator as any).nextStore = null;
      await plugin.onunload();
    }
  });
});
