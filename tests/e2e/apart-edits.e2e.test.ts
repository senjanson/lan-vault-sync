/**
 * Notes edited on two devices while they were apart (one offline, or with
 * sync stopped), then synced again. Edits to different lines merge; edits to
 * the same line must not be merged character by character into text neither
 * device wrote: the later version is kept and the other one is kept as a
 * conflict copy, the same on every device.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// UDP broadcast is process-global; scenarios connect through manual peers.
vi.mock('../../src/discovery/udp-broadcast', () => ({
  UdpBroadcast: class {
    onDeviceSeen() {}
    async start() {}
    stop() {}
  },
}));

import fs from 'node:fs';
import path from 'node:path';
import { decodeMessage, decodeSyncStep1Data, decodeYjsSync, encodeYjsSync } from '../../src/transport/protocol';
import { MessageType } from '../../src/types';
import { Node, ports, seed, sleep, startNode, tmpRoot, until } from './harness';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

const notes = (root: string) => fs.readdirSync(root).filter((f) => f.endsWith('.md')).sort();
const copies = (root: string) => notes(root).filter((f) => f.includes('(conflict '));

/** Write a note on disk with a given modification time (seconds ago). */
function seedAt(root: string, file: string, text: string, secondsAgo: number) {
  seed(root, { [file]: text });
  const at = (Date.now() - secondsAgo * 1000) / 1000;
  fs.utimesSync(path.join(root, file), at, at);
}

/** Two devices that synced `files`, then were both stopped. */
async function syncedThenStopped(files: Record<string, string>) {
  const ra = tmpRoot('a'), rb = tmpRoot('b');
  seed(ra, files);
  const pa = ports(), pb = pa + 1;
  const A = await startNode(ra, 'aaaa', pa, []);
  const B = await startNode(rb, 'bbbb', pb, [pa]);
  await until(() => Object.entries(files).every(([f, t]) => B.vault.text(f) === t));
  await sleep(500);
  await A.coord.stop();
  await B.coord.stop();
  return { ra, rb, pa, pb };
}

describe('e2e edits made apart', { timeout: 40000 }, () => {
  it('keeps the later version and one copy of the other when both rewrote the same line', async () => {
    const base = 'title\nshared line\nend\n';
    const partBase = 'hello world\nsecond\n';
    const { ra, rb, pa, pb } = await syncedThenStopped({ 'n.md': base, 'p.md': partBase });
    // A rewrote the line first, B later (the real-device case).
    seedAt(ra, 'n.md', 'title\nhub version, earlier\nend\n', 60);
    seedAt(rb, 'n.md', 'title\nother version, later\nend\n', 30);
    // The later side kept part of the line the other side deleted.
    seedAt(ra, 'p.md', 'hello there\nsecond\n', 60);
    seedAt(rb, 'p.md', 'hello world!!\nsecond\n', 30);
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pb, [pa]));
    const settled = () =>
      [A, B].every((n) => n.vault.text('n.md') === 'title\nother version, later\nend\n' &&
        n.vault.text('p.md') === 'hello world!!\nsecond\n') &&
      copies(ra).length === 2 && copies(rb).length === 2;
    await until(settled, 10000);
    await sleep(1500);
    for (const n of [A, B]) {
      expect(n.vault.text('n.md')).toBe('title\nother version, later\nend\n');
      expect(n.vault.text('p.md')).toBe('hello world!!\nsecond\n');
    }
    expect(copies(ra)).toEqual(copies(rb));
    expect(copies(ra)).toHaveLength(2);
    const kept = copies(ra).map((f) => A.vault.text(f)).sort();
    expect(kept).toEqual(['hello there\nsecond\n', 'title\nhub version, earlier\nend\n']);
    for (const f of copies(ra)) expect(B.vault.text(f)).toBe(A.vault.text(f));
  });

  it('merges edits to different lines without a copy', async () => {
    const base = 'one\ntwo\nthree\nfour\nfive\n';
    const { ra, rb, pa, pb } = await syncedThenStopped({ 'n.md': base });
    seedAt(ra, 'n.md', 'one A\ntwo\nthree\nfour\nfive\n', 60);
    seedAt(rb, 'n.md', 'one\ntwo\nthree\nfour B\nfive\n', 30);
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pb, [pa]));
    const merged = 'one A\ntwo\nthree\nfour B\nfive\n';
    await until(() => [A, B].every((n) => n.vault.text('n.md') === merged), 10000);
    await sleep(1500);
    for (const n of [A, B]) expect(n.vault.text('n.md')).toBe(merged);
    expect(copies(ra)).toEqual([]);
    expect(copies(rb)).toEqual([]);
  });

  it('merges a line added at the end with an edit elsewhere, without a copy', async () => {
    const base = 'alpha\nbeta\ngamma';
    const { ra, rb, pa, pb } = await syncedThenStopped({ 'n.md': base, 'm.md': 'x\ny' });
    seedAt(ra, 'n.md', 'alpha\nbeta\ngamma\nadded on A', 30);
    seedAt(rb, 'n.md', 'alpha changed\nbeta\ngamma', 60);
    // Both added a line at the end of a note that has no final newline: each
    // added line stays whole, in either order.
    seedAt(ra, 'm.md', 'x\ny\nfrom A', 30);
    seedAt(rb, 'm.md', 'x\ny\nfrom B', 60);
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pb, [pa]));
    const merged = 'alpha changed\nbeta\ngamma\nadded on A';
    const both = ['x\ny\nfrom A\nfrom B', 'x\ny\nfrom B\nfrom A'];
    await until(() => [A, B].every((n) => n.vault.text('n.md') === merged && both.includes(n.vault.text('m.md')!)), 10000);
    await sleep(1500);
    for (const n of [A, B]) {
      expect(n.vault.text('n.md')).toBe(merged);
      expect(both).toContain(n.vault.text('m.md'));
    }
    expect(A.vault.text('m.md')).toBe(B.vault.text('m.md'));
    expect(copies(ra)).toEqual([]);
    expect(copies(rb)).toEqual([]);
  });

  it('keeps the later version when the device that kept running edited the same line', async () => {
    const base = 'title\nshared line\nend\n';
    const { ra, rb, pa, pb } = await syncedThenStopped({ 'n.md': base });
    const A = track(await startNode(ra, 'aaaa', pa, []));
    // B's sync is off; its note is edited meanwhile, then A's (later).
    seedAt(rb, 'n.md', 'title\nedited while stopped\nend\n', 60);
    await sleep(300);
    await A.vault.write('n.md', 'title\nedited while running\nend\n');
    await sleep(300);
    const B = track(await startNode(rb, 'bbbb', pb, [pa]));
    const want = 'title\nedited while running\nend\n';
    await until(() => [A, B].every((n) => n.vault.text('n.md') === want) && copies(ra).length === 1 && copies(rb).length === 1, 10000);
    await sleep(1500);
    for (const n of [A, B]) expect(n.vault.text('n.md')).toBe(want);
    expect(copies(ra)).toEqual(copies(rb));
    expect(copies(ra)).toHaveLength(1);
    expect(A.vault.text(copies(ra)[0])).toBe('title\nedited while stopped\nend\n');
  });

  it('resolves it the same on three devices when one relays for another', async () => {
    // C only reaches A through H (two phones and a desktop, say).
    const ra = tmpRoot('a'), rh = tmpRoot('h'), rc = tmpRoot('c');
    const base = 'title\nshared line\nend\nlast\n';
    seed(rh, { 'n.md': base });
    const pa = ports(), ph = pa + 1, pc = pa + 2;
    let H = await startNode(rh, 'hhhh', ph, []);
    let A = await startNode(ra, 'aaaa', pa, [ph]);
    let C = await startNode(rc, 'cccc', pc, [ph]);
    await until(() => [A, C].every((n) => n.vault.text('n.md') === base));
    await sleep(500);
    await A.coord.stop();
    // H and C keep syncing; H edits the line, and C edits another one.
    H = track(H);
    C = track(C);
    await H.vault.write('n.md', 'title\nhub version, earlier\nend\nlast\n');
    await until(() => C.vault.text('n.md') === 'title\nhub version, earlier\nend\nlast\n');
    await C.vault.write('n.md', 'title\nhub version, earlier\nend\nlast C\n');
    await until(() => H.vault.text('n.md') === 'title\nhub version, earlier\nend\nlast C\n');
    await sleep(300);
    // A, apart, rewrote the same line later.
    seedAt(ra, 'n.md', 'title\nother version, later\nend\nlast\n', 0);
    A = track(await startNode(ra, 'aaaa', pa, [ph]));
    const want = 'title\nother version, later\nend\nlast\n';
    const all = [A, H, C];
    const roots = [ra, rh, rc];
    await until(() => all.every((n) => n.vault.text('n.md') === want) && roots.every((r) => copies(r).length === 1), 12000);
    await sleep(1500);
    for (const n of all) expect(n.vault.text('n.md')).toBe(want);
    for (const r of roots) expect(copies(r)).toEqual(copies(ra));
    expect(copies(ra)).toHaveLength(1);
    for (const n of all) expect(n.vault.text(copies(ra)[0])).toBe('title\nhub version, earlier\nend\nlast C\n');
  });

  it('resolves it once when a device comes back to two peers that both hold the other version', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    const base = 'hello world\nsecond\n';
    seed(ra, { 'n.md': base });
    const pa = ports(), pb = pa + 1, pc = pa + 2;
    let A = await startNode(ra, 'aaaa', pa, [pb, pc]);
    let B = await startNode(rb, 'bbbb', pb, [pa, pc]);
    let C = await startNode(rc, 'cccc', pc, [pa, pb]);
    await until(() => [B, C].every((n) => n.vault.text('n.md') === base));
    await sleep(500);
    await B.coord.stop();
    A = track(A);
    C = track(C);
    // A and C hold "hello there"; B, apart and later, kept "world" that
    // they deleted, so both may have to put it back.
    await A.vault.write('n.md', 'hello there\nsecond\n');
    await until(() => C.vault.text('n.md') === 'hello there\nsecond\n');
    await sleep(300);
    seedAt(rb, 'n.md', 'hello world!!\nsecond\n', 0);
    B = track(await startNode(rb, 'bbbb', pb, [pa, pc]));
    const want = 'hello world!!\nsecond\n';
    const all = [A, B, C];
    const roots = [ra, rb, rc];
    await until(() => all.every((n) => n.vault.text('n.md') === want) && roots.every((r) => copies(r).length === 1), 12000);
    await sleep(2000);
    for (const n of all) expect(n.vault.text('n.md')).toBe(want);
    for (const r of roots) expect(copies(r)).toEqual(copies(ra));
    expect(copies(ra)).toHaveLength(1);
    for (const n of all) expect(n.vault.text(copies(ra)[0])).toBe('hello there\nsecond\n');
  });

  it('still syncs with a device that does not send its text (an older version)', async () => {
    const base = 'title\nshared line\nend\n';
    const { ra, rb, pa, pb } = await syncedThenStopped({ 'n.md': base });
    seedAt(ra, 'n.md', 'title\nhub version, earlier\nend\n', 60);
    seedAt(rb, 'n.md', 'title\nother version, later\nend\n', 30);
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pb, []));
    // B behaves like 0.4.0: its requests carry only the state vector, and
    // it ignores the text that comes with A's.
    const cm = (B.coord as any).connectionManager;
    const sendTo = cm.sendTo.bind(cm);
    cm.sendTo = (id: string, data: Uint8Array) => {
      const msg = decodeMessage(data);
      if (msg.type !== MessageType.YJS_SYNC_STEP1) return sendTo(id, data);
      const { filePath, data: sv } = decodeYjsSync(msg.payload);
      return sendTo(id, encodeYjsSync(MessageType.YJS_SYNC_STEP1, filePath, decodeSyncStep1Data(sv).stateVector));
    };
    (B.coord as any)._noteApartText = () => undefined;
    B.coord.addManualPeer(`127.0.0.1:${pa}`);
    // Merged as before: both end with the same text, and no copy.
    await until(() => A.vault.text('n.md') === B.vault.text('n.md') && A.vault.text('n.md') !== 'title\nhub version, earlier\nend\n', 10000);
    await sleep(1500);
    expect(A.vault.text('n.md')).toBe(B.vault.text('n.md'));
    expect(A.vault.text('n.md')).toContain('title\n');
    expect(copies(ra)).toEqual([]);
    expect(copies(rb)).toEqual([]);
  });
});
