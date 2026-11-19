import { describe, expect, it, vi } from 'vitest';
import { SyncView, type SyncViewStatus } from '../../src/ui/sync-view';

/** Just enough of Obsidian's element helpers to read what the view shows. */
class FakeEl {
  children: FakeEl[] = [];
  constructor(public text = '') {}
  empty() { this.children = []; }
  addClass() {}
  private add(opts?: { text?: string }) {
    const el = new FakeEl(opts?.text ?? '');
    this.children.push(el);
    return el;
  }
  createDiv(opts?: { text?: string }) { return this.add(opts); }
  createSpan(opts?: { text?: string }) { return this.add(opts); }
  createEl(_tag: string, opts?: { text?: string }) { return this.add(opts); }
  find(text: string): any { return this.text === text ? this : this.children.map((c) => c.find(text)).find(Boolean); }
  allText(): string { return [this.text, ...this.children.map((c) => c.allText())].filter(Boolean).join(' | '); }
}

function openView(getStatus: () => SyncViewStatus, actions?: any) {
  const view = new SyncView({} as any, getStatus, actions) as any;
  const content = new FakeEl();
  view.containerEl = { children: [new FakeEl(), content] };
  return { view, content };
}

const device = (name: string) => ({ deviceId: name, deviceName: name, ip: '10.0.0.2', port: 50000, vaultId: 'v', lastSeen: 0 });

describe('SyncView', () => {
  it('shows the current state and connected devices as soon as it opens', async () => {
    const { view, content } = openView(() => ({
      state: 'watching',
      devices: [device('mac'), device('iphone'), device('pixel')],
      unreachable: [],
    }));
    await view.onOpen();
    const text = content.allText();
    expect(text).toContain('Syncing');
    expect(text).toContain('Connected devices (3)');
    expect(text).toContain('iphone');
  });

  it('shows the status again when it changes', async () => {
    let status: SyncViewStatus = { state: 'watching', devices: [], unreachable: [] };
    const { view, content } = openView(() => status);
    await view.onOpen();
    status = { state: 'watching', devices: [device('mac')], unreachable: ['192.168.1.5:50000'] };
    view.refresh();
    expect(content.allText()).toContain('Connected devices (1)');
    expect(content.allText()).toContain('Cannot reach 192.168.1.5:50000');
  });

  it('lists held deletions and passes the choice on', async () => {
    const resolveHeld = vi.fn(async () => undefined);
    const paths = Array.from({ length: 7 }, (_, i) => `f${i}.md`);
    const { view, content } = openView(() => ({
      state: 'watching',
      devices: [],
      unreachable: [],
      held: [{ id: 'h1', kind: 'incoming', peer: 'pixel', since: 0, paths }],
    }), { resolveHeld });
    await view.onOpen();
    const text = content.allText();
    expect(text).toContain('Deletions waiting for you (1)');
    expect(text).toContain('pixel deleted 7 file(s)');
    expect(text).toContain('and 2 more');
    await content.find('Keep them').onclick();
    expect(resolveHeld).toHaveBeenCalledWith('h1', 'keep');
  });

  it('puts Keep first and says so when a held group was already handled', async () => {
    const { Notice } = await import('obsidian');
    (Notice as any).shown = [];
    const resolveHeld = vi.fn(async () => false);
    const { view, content } = openView(() => ({
      state: 'watching',
      devices: [],
      unreachable: [],
      held: [{ id: 'h1', kind: 'incoming', peer: 'pixel', since: 0, paths: ['a.md'] }],
    }), { resolveHeld });
    await view.onOpen();
    const text = content.allText();
    expect(text.indexOf('| Keep them |')).toBeLessThan(text.indexOf('| Delete them'));
    await content.find('Keep them').onclick();
    expect((Notice as any).shown.join(' ')).toContain('already handled');
  });

  it('lists files too large for one side apart, and a device that left as disconnected', async () => {
    const peer = (id: string, extra: object) => ({
      id, name: `${id} (${id})`, connected: true, lastExchange: 0, differing: 0, unsynced: [], waiting: 0,
      tooLargeHere: [], tooLargeThere: [], ...extra,
    });
    const { view, content } = openView(() => ({
      state: 'watching',
      devices: [device('pixel')],
      unreachable: [],
      health: [
        peer('pixel', { tooLargeHere: ['big.bin'], tooLargeThere: ['a.bin', 'b.bin'] }),
        peer('macb', { connected: false, differing: 1, unsynced: ['x.md'] }),
      ],
    }));
    await view.onOpen();
    const text = content.allText();
    expect(text).toContain('pixel: all files match');
    expect(text).toContain('1 file(s) not received: larger than this device');
    expect(text).toContain("2 file(s) not sent: larger than pixel's limit");
    expect(text).toContain('macb: disconnected');
    expect(text).not.toContain('not yet in sync');
  });

  it('says when a connection is limited to one folder, and when a device that is away was last in sync', async () => {
    const { setLanguage } = await import('../../src/i18n');
    const peer = (id: string, extra: object) => ({
      id, name: `${id} (${id})`, connected: true, lastExchange: Date.now(), differing: 0, unsynced: [], waiting: 0,
      tooLargeHere: [], tooLargeThere: [], ...extra,
    });
    const synced = new Date(2025, 2, 4, 9, 5).getTime();
    const status = (): SyncViewStatus => ({
      state: 'watching',
      devices: [device('work')],
      unreachable: [],
      health: [
        // Read back after a restart: never compared since.
        peer('home', { connected: false, lastExchange: undefined, lastConsistent: synced }),
        peer('work', { only: 'Work' }),
        peer('tablet', { connected: false, lastExchange: undefined }),
      ],
    });
    try {
      setLanguage('en');
      const { view, content } = openView(status);
      await view.onOpen();
      const text = content.allText();
      expect(text).toMatch(/work: all files match \(checked \d+:\d\d [AP]M\) · syncs only Work/);
      expect(text).toContain('home: disconnected · last in sync Mar 4, 2025, 9:05 AM');
      expect(text).toContain('tablet: disconnected · not fully in sync yet');
      // Connected devices first.
      expect(text.indexOf('work: all files match')).toBeLessThan(text.indexOf('home: disconnected'));
      setLanguage('zh');
      view.refresh();
      const zh = content.allText();
      expect(zh).toContain('· 仅同步 Work');
      expect(zh).toContain('home：已断开 · 上次同步 2025-03-04 09:05');
      expect(zh).toContain('tablet：已断开 · 还没有完整同步过');
    } finally {
      setLanguage(null);
    }
  });

  it('dates an alert from another day', async () => {
    const { setLanguage } = await import('../../src/i18n');
    const last = new Date(2025, 0, 2, 13, 4).getTime();
    try {
      setLanguage('zh');
      const { view, content } = openView(() => ({
        state: 'watching',
        devices: [],
        unreachable: [],
        alerts: [{ key: 'write-failed\na.md', kind: 'write-failed', msg: 'EIO', first: last, last, count: 1 }],
      }));
      await view.onOpen();
      expect(content.allText()).toContain('2025-01-02 13:04 LAN Vault Sync 没能写入文件：EIO');
    } finally {
      setLanguage(null);
    }
  });
});
