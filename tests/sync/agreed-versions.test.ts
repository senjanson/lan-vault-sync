import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataAdapter } from 'obsidian';
import { AgreedVersions } from '../../src/sync/agreed-versions';
import type { FileMeta } from '../../src/types';
import { AGREED_HASHES_FILE } from '../../src/constants';
import { MemoryAdapter } from '../diagnostics/memory-adapter';

const meta = (path: string, hash: string): FileMeta => ({ path, hash, mtime: 1, size: 1, isTextFile: false });
const list = (...files: FileMeta[]) => new Map(files.map((f) => [f.path, f]));

describe('AgreedVersions.confirmed', () => {
  it('is the version last shared with a peer while our copy has not changed since', () => {
    const agreed = new AgreedVersions(null as unknown as DataAdapter);
    agreed.noteLists('mac', list(meta('p.png', 'v1')), list(meta('p.png', 'v1')), () => undefined);
    expect(agreed.confirmed('mac', 'p.png')).toBe('v1');
    expect(agreed.snapshot('mac').get('p.png')).toBe('v1');
  });

  it('is not, after a change here, even back to the same bytes, until the peer has our copy', () => {
    const agreed = new AgreedVersions(null as unknown as DataAdapter);
    agreed.noteLists('mac', list(meta('p.png', 'v1')), list(meta('p.png', 'v1')), () => undefined);
    // Changed to v3 and back to v1 here; sending does not make it shared.
    agreed.noteChanged('p.png');
    expect(agreed.with('mac', 'p.png')).toBe('v1');
    expect(agreed.confirmed('mac', 'p.png')).toBeUndefined();
    expect(agreed.snapshot('mac').has('p.png')).toBe(false);
    // The peer refused it: the two lists still differ.
    agreed.noteLists('mac', list(meta('p.png', 'v1')), list(meta('p.png', 'v2')), () => undefined);
    expect(agreed.confirmed('mac', 'p.png')).toBeUndefined();
    // Both list the same copy again.
    agreed.noteLists('mac', list(meta('p.png', 'v1')), list(meta('p.png', 'v1')), () => undefined);
    expect(agreed.confirmed('mac', 'p.png')).toBe('v1');
  });

  it("is not, for other peers, once another peer's version replaced our copy", () => {
    const agreed = new AgreedVersions(null as unknown as DataAdapter);
    for (const peer of ['mac', 'pixel']) agreed.noteLists(peer, list(meta('p.png', 'v1')), list(meta('p.png', 'v1')), () => undefined);
    agreed.noteShared('pixel', 'p.png', 'v2');
    expect(agreed.confirmed('pixel', 'p.png')).toBe('v2');
    expect(agreed.confirmed('mac', 'p.png')).toBeUndefined();
    // Back to v1 from the Pixel: still not what Mac and we last had in common.
    agreed.noteShared('pixel', 'p.png', 'v1');
    expect(agreed.confirmed('mac', 'p.png')).toBeUndefined();
    // Received from Mac itself.
    agreed.noteShared('mac', 'p.png', 'v1');
    expect(agreed.confirmed('mac', 'p.png')).toBe('v1');
  });

  it('remembers a change here across a restart', async () => {
    const adapter = new MemoryAdapter();
    const first = new AgreedVersions(adapter as unknown as DataAdapter);
    first.noteLists('mac', list(meta('p.png', 'v1'), meta('q.png', 'w1')), list(meta('p.png', 'v1'), meta('q.png', 'w1')), () => undefined);
    first.noteChanged('p.png');
    await first.save();
    const second = new AgreedVersions(adapter as unknown as DataAdapter);
    await second.load();
    expect(second.with('mac', 'p.png')).toBe('v1');
    expect(second.confirmed('mac', 'p.png')).toBeUndefined();
    expect(second.confirmed('mac', 'q.png')).toBe('w1');
  });
});

describe('AgreedVersions saving', () => {
  afterEach(() => vi.useRealTimers());

  it('writes a version received from a peer soon, once for a burst of them', async () => {
    vi.useFakeTimers();
    const adapter = new MemoryAdapter();
    let writes = 0;
    const write = adapter.write.bind(adapter);
    adapter.write = async (p: string, d: string) => { if (p.startsWith(AGREED_HASHES_FILE)) writes++; return write(p, d); };
    const agreed = new AgreedVersions(adapter as unknown as DataAdapter);
    // A first sync: a thousand files received one after another.
    for (let i = 0; i < 1000; i++) agreed.noteShared('mac', `img${i}.png`, `h${i}`);
    expect(writes).toBe(0);
    await vi.advanceTimersByTimeAsync(1100);
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThanOrEqual(2);
    const saved = JSON.parse(adapter.files.get(AGREED_HASHES_FILE) as string);
    expect(saved.files['img999.png']).toBe('h999');
    // No list exchange, no persist: a restart reads it back.
    const again = new AgreedVersions(adapter as unknown as DataAdapter);
    await again.load();
    expect(again.with('mac', 'img0.png')).toBe('h0');
  });

  it('leaves no write behind once closed', async () => {
    vi.useFakeTimers();
    const adapter = new MemoryAdapter();
    const agreed = new AgreedVersions(adapter as unknown as DataAdapter);
    agreed.noteShared('mac', 'a.png', 'h1');
    await agreed.close();
    expect(JSON.parse(adapter.files.get(AGREED_HASHES_FILE) as string).files['a.png']).toBe('h1');
    let writes = 0;
    const write = adapter.write.bind(adapter);
    adapter.write = async (p: string, d: string) => { writes++; return write(p, d); };
    agreed.noteShared('mac', 'b.png', 'h2');
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AgreedVersions and files the peer deleted', () => {
  it('keeps the version last shared of an attachment the peer deleted while it is still here', () => {
    const agreed = new AgreedVersions(null as unknown as DataAdapter);
    const here = list(meta('p.png', 'v1'), meta('n.md', 'n1'));
    (here.get('n.md') as FileMeta).isTextFile = true;
    agreed.noteLists('mac', here, list(meta('p.png', 'v1'), { ...meta('n.md', 'n1'), isTextFile: true }), () => undefined);
    // Mac deleted both.
    agreed.noteLists('mac', here, list(), () => undefined, new Set(['p.png', 'n.md']));
    expect(agreed.forPeer('mac')?.get('p.png')).toBe('v1');
    expect(agreed.forPeer('mac')?.has('n.md')).toBe(false);
    // Gone here too: forgotten.
    agreed.noteLists('mac', list(), list(), () => undefined, new Set(['p.png']));
    expect(agreed.forPeer('mac')?.has('p.png')).toBe(false);
  });
});

