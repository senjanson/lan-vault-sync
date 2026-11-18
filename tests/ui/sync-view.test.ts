import { describe, expect, it } from 'vitest';
import { SyncView, type SyncViewStatus } from '../../src/ui/sync-view';

/** Just enough of Obsidian's element helpers to read what the view shows. */
class FakeEl {
  children: FakeEl[] = [];
  constructor(public text = '') {}
  empty() { this.children = []; }
  private add(opts?: { text?: string }) {
    const el = new FakeEl(opts?.text ?? '');
    this.children.push(el);
    return el;
  }
  createDiv(opts?: { text?: string }) { return this.add(opts); }
  createSpan(opts?: { text?: string }) { return this.add(opts); }
  createEl(_tag: string, opts?: { text?: string }) { return this.add(opts); }
  allText(): string { return [this.text, ...this.children.map((c) => c.allText())].filter(Boolean).join(' | '); }
}

function openView(getStatus: () => SyncViewStatus) {
  const view = new SyncView({} as any, getStatus) as any;
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
});
