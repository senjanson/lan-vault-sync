import { describe, expect, it, vi } from 'vitest';
import { RecoveryView, registerRecoveryCenter, RECOVERY_VIEW_TYPE } from '../../src/history/recovery-view';
import type { VersionEntry, VersionGroup } from '../../src/history/version-store';

/** Just enough of Obsidian's element helpers to read what the view shows. */
class FakeEl {
  children: FakeEl[] = [];
  value = '';
  onclick?: () => unknown;
  oninput?: () => unknown;
  constructor(public tag = 'div', public text = '') {}
  empty() { this.children = []; }
  private add(tag: string, opts?: { text?: string; value?: string }) {
    const el = new FakeEl(tag, opts?.text ?? '');
    if (opts?.value) el.value = opts.value;
    this.children.push(el);
    return el;
  }
  createDiv(opts?: { text?: string }) { return this.add('div', opts); }
  createSpan(opts?: { text?: string }) { return this.add('span', opts); }
  createEl(tag: string, opts?: { text?: string }) { return this.add(tag, opts); }
  find(pred: string | ((e: FakeEl) => boolean)): any {
    const hit = typeof pred === 'string' ? this.text === pred : pred(this);
    return hit ? this : this.children.map((c) => c.find(pred)).find(Boolean);
  }
  findAll(text: string): FakeEl[] {
    return [...(this.text === text ? [this] : []), ...this.children.flatMap((c) => c.findAll(text))];
  }
  allText(): string { return [this.text, ...this.children.map((c) => c.allText())].filter(Boolean).join(' | '); }
}

const entry = (path: string, ts: number): VersionEntry =>
  ({ ts, path, hash: 'a'.repeat(64), size: 1200, op: 'delete', peer: 'pixel', batch: 'bulk-1' });

function openView(groups: VersionGroup[]) {
  const store = {
    groups: vi.fn(async () => groups),
    restoreGroup: vi.fn(async (entries: VersionEntry[]) => ({ restored: entries.map((e) => e.path), failed: [] })),
    restore: vi.fn(async () => true),
    read: vi.fn(async () => null),
  };
  const vault = { name: 'vault' };
  const view = new RecoveryView({} as any, store as any, vault as any) as any;
  const content = new FakeEl();
  view.containerEl = { children: [new FakeEl(), content] };
  return { view, content, store, vault };
}

describe('RecoveryView', () => {
  const entries = [entry('notes/a.md', 2000), entry('notes/b.md', 1000), entry('img/c.png', 500)];
  const group: VersionGroup = { key: 'batch:bulk-1', peer: 'pixel', batch: 'bulk-1', ops: ['delete'], from: 500, to: 2000, entries };

  it('lists a group, and Restore all hands its entries to the store', async () => {
    const { view, content, store, vault } = openView([group]);
    await view.onOpen();
    const text = content.allText();
    expect(text).toContain('Recovery center');
    expect(text).toContain('pixel');
    expect(text).toContain('3 file(s)');
    expect(text).toContain('Batch bulk-1');
    expect(text).toContain('notes/a.md');
    expect(text).toContain('1.2 KB');
    expect(content.findAll('Restore')).toHaveLength(3);
    content.find('Restore all').onclick();
    await vi.waitFor(() => expect(store.restoreGroup).toHaveBeenCalledWith(entries, vault));
    await vi.waitFor(() => expect(store.groups).toHaveBeenCalledTimes(2));
  });

  it('filters by path, and Restore all then restores the matches', async () => {
    const { view, content, store, vault } = openView([group]);
    await view.onOpen();
    const search = content.find((e: FakeEl) => e.tag === 'input');
    search.value = 'NOTES/';
    search.oninput();
    const text = content.allText();
    expect(text).toContain('notes/b.md');
    expect(text).not.toContain('img/c.png');
    content.find('Restore all').onclick();
    await vi.waitFor(() => expect(store.restoreGroup).toHaveBeenCalledWith(entries.slice(0, 2), vault));
    search.value = 'nothing';
    search.oninput();
    expect(content.allText()).toContain('No kept version matches "nothing"');
  });

  it('gives a group made within one second one time, not a range', async () => {
    const { view, content } = openView([{ ...group, from: 1000, to: 1900 }]);
    await view.onOpen();
    expect(content.allText()).not.toContain(' – ');
  });

  it('restores one entry', async () => {
    const { view, content, store, vault } = openView([group]);
    await view.onOpen();
    content.find('Restore').onclick();
    await vi.waitFor(() => expect(store.restore).toHaveBeenCalledWith(entries[0], vault));
  });

  it('says so when the store is not ready', async () => {
    const view = new RecoveryView({} as any, () => null) as any;
    const content = new FakeEl();
    view.containerEl = { children: [new FakeEl(), content] };
    await view.onOpen();
    expect(content.allText()).toContain('not ready');
  });

  it('registers the view and the command', () => {
    const plugin = { app: { vault: {} }, registerView: vi.fn(), addCommand: vi.fn() };
    registerRecoveryCenter(plugin as any, () => null);
    expect(plugin.registerView).toHaveBeenCalledWith(RECOVERY_VIEW_TYPE, expect.any(Function));
    expect(plugin.addCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'open-recovery-center', name: 'Open recovery center' }));
  });
});
