/**
 * Notes open in an editor, and attachments changed around a peer's write.
 * Text typed in an editor reaches the plugin through "editor-change" events
 * (taken in 200 ms after the last keystroke) and reaches the file only when
 * Obsidian saves it, about 2 s later (see MockEditor).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/discovery/udp-broadcast', () => ({
  UdpBroadcast: class {
    onDeviceSeen() {}
    async start() {}
    stop() {}
  },
}));

import fs from 'node:fs';
import path from 'node:path';
import { MockWorkspace, Node, ports, seed, sleep, startNode, tmpRoot, until } from './harness';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

async function startWithEditor(root: string, id: string, port: number, peers: number[]) {
  const ws = new MockWorkspace();
  const node = track(await startNode(root, id, port, peers, {}, { workspace: ws }));
  ws.attach(node.vault);
  return { node, ws };
}

async function stopNode(n: Node) {
  await n.coord.stop();
  nodes = nodes.filter((x) => x !== n);
}

const copies = (root: string) => fs.readdirSync(root).filter((f) => f.includes('(conflict ')).sort();
const occurrences = (text: string | null, token: string) => (text ?? '').split(token).length - 1;

describe('e2e a peer deletes a note while text typed here is not saved yet', { timeout: 40000 }, () => {
  it('keeps the note with the typed text on both devices (live deletion), also after a restart', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'line one\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const { node: B0, ws } = await startWithEditor(rb, 'bbbb', pa + 1, [pa]);
    await until(() => B0.vault.text('n.md') === 'line one\n');
    await sleep(800);
    const editor = ws.open('n.md');
    // Typed on B, neither in the doc yet (the editor's change waits out its
    // debounce) nor on disk; A deletes the note a moment later.
    editor.type((v) => v + 'TYPED-ON-B\n');
    await sleep(30);
    await A.vault.rm('n.md');
    await until(() => A.vault.text('n.md')?.includes('TYPED-ON-B') === true && B0.vault.text('n.md')?.includes('TYPED-ON-B') === true, 15000);
    expect(B0.vault.text('n.md')).toBe('line one\nTYPED-ON-B\n');
    expect(A.vault.text('n.md')).toBe('line one\nTYPED-ON-B\n');
    // Was: B's synced-files list kept the note B no longer had, and at its
    // next start B took it for one deleted while sync was off, and deleted
    // it on A too.
    await sleep(1000);
    await stopNode(B0);
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1500);
    await (B.coord as any)._periodicFullSync();
    await sleep(1500);
    expect(A.vault.text('n.md')).toBe('line one\nTYPED-ON-B\n');
    expect(B.vault.text('n.md')).toBe('line one\nTYPED-ON-B\n');
  });

  it('keeps the note with the typed text when the deletion comes with the file lists after being apart', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'line one\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B0 = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B0.vault.text('n.md') === 'line one\n');
    await sleep(800);
    await stopNode(B0);
    await A.vault.rm('n.md');
    await sleep(300);
    const { node: B, ws } = await startWithEditor(rb, 'bbbb', pa + 1, [pa]);
    const editor = ws.open('n.md');
    // Typed without a pause while the two connect and exchange file lists,
    // so the change is still waiting to be taken in, and not saved yet,
    // when A's record of the deletion arrives.
    for (let i = 0; i < 30; i++) {
      editor.type((v) => v + `[t${i}]`);
      await sleep(40);
    }
    await until(() => A.vault.text('n.md')?.includes('[t29]') === true && B.vault.text('n.md')?.includes('[t29]') === true, 15000);
    for (const n of [A, B]) {
      for (let i = 0; i < 30; i++) expect(occurrences(n.vault.text('n.md'), `[t${i}]`)).toBe(1);
    }
    expect(B.vault.text('n.md')).toBe(editor.getValue());
    expect(A.vault.text('n.md')).toBe(editor.getValue());
  });
});

describe('e2e a note typed in and then deleted here', { timeout: 30000 }, () => {
  it('stays deleted on every device', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'line one\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const { node: B, ws } = await startWithEditor(rb, 'bbbb', pa + 1, [pa]);
    await until(() => B.vault.text('n.md') === 'line one\n');
    await sleep(800);
    const editor = ws.open('n.md');
    editor.type((v) => v + 'typed, then the note deleted\n');
    await sleep(50);
    await B.vault.rm('n.md');
    await until(() => !A.vault.exists('n.md'));
    // Was: the typed change, still waiting when the note was deleted, was
    // taken in afterwards and brought the note back on A.
    await sleep(1500);
    expect(A.vault.exists('n.md')).toBe(false);
    await (A.coord as any)._periodicFullSync();
    await sleep(1500);
    expect(A.vault.exists('n.md')).toBe(false);
    expect(B.vault.exists('n.md')).toBe(false);
  });
});

describe('e2e the synced-files list', { timeout: 30000 }, () => {
  it('lists only files that are here, so a stale record is not taken for a deletion at the next start', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'g.md': 'kept on A\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B0 = track(await startNode(rb, 'bbbb', pa + 1, []));
    // A hash recorded for a note that is not here (as a change taken in for
    // a note already gone used to leave).
    (B0.coord as any).knownHashes.set('g.md', await (B0.coord as any)._hashText('kept on A\n'));
    await stopNode(B0);
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('g.md') === 'kept on A\n', 10000);
    expect(B.vault.text('g.md')).toBe('kept on A\n');
    expect(A.vault.text('g.md')).toBe('kept on A\n');
  });
});

describe('e2e a note missing here whose doc holds the peer\'s text', { timeout: 30000 }, () => {
  it('writes the file again when the peer lists the note', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'from A\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n.md') === 'from A\n');
    await sleep(800);
    // Gone from disk with no event seen; the doc still holds the text.
    fs.rmSync(path.join(rb, 'n.md'));
    B.vault.files.delete('n.md');
    await (B.coord as any)._periodicFullSync();
    // Was: fetching the note changed nothing in the doc, so nothing wrote
    // the file, at this exchange or any later one.
    await until(() => B.vault.text('n.md') === 'from A\n', 8000);
    expect(B.vault.text('n.md')).toBe('from A\n');
    expect(A.vault.text('n.md')).toBe('from A\n');
  });
});

describe('e2e notes open in editors', { timeout: 40000 }, () => {
  it('two devices typing in one note at once: every token once, on both, editors equal to the files', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'start\n' });
    const pa = ports();
    const { node: A, ws: wsA } = await startWithEditor(ra, 'aaaa', pa, []);
    const { node: B, ws: wsB } = await startWithEditor(rb, 'bbbb', pa + 1, [pa]);
    await until(() => B.vault.text('n.md') === 'start\n');
    await sleep(800);
    const eA = wsA.open('n.md');
    const eB = wsB.open('n.md');
    for (let i = 0; i < 40; i++) {
      eA.type((v) => v + `[a${i}]`);
      eB.type((v) => `[b${i}]` + v);
      await sleep(100);
    }
    const settled = () =>
      A.vault.text('n.md') === B.vault.text('n.md') &&
      eA.getValue() === A.vault.text('n.md') &&
      eB.getValue() === B.vault.text('n.md') &&
      eA.getValue().includes('[a39]') && eA.getValue().includes('[b39]');
    await until(settled, 15000);
    expect(settled()).toBe(true);
    for (const n of [A, B]) {
      for (let i = 0; i < 40; i++) {
        expect(occurrences(n.vault.text('n.md'), `[a${i}]`)).toBe(1);
        expect(occurrences(n.vault.text('n.md'), `[b${i}]`)).toBe(1);
      }
      expect(occurrences(n.vault.text('n.md'), 'start')).toBe(1);
    }
  });

  it('typing while the peer renames the note: every token ends in the renamed note on both', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'start\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const { node: B, ws } = await startWithEditor(rb, 'bbbb', pa + 1, [pa]);
    await until(() => B.vault.text('n.md') === 'start\n');
    await sleep(800);
    const editor = ws.open('n.md');
    for (let i = 0; i < 30; i++) {
      editor.type((v) => v + `[b${i}]`);
      if (i === 10) await A.vault.mv('n.md', 'm.md');
      await sleep(100);
    }
    const done = () =>
      [A, B].every((n) => !n.vault.exists('n.md') && n.vault.text('m.md')?.includes('[b29]') === true) &&
      A.vault.text('m.md') === B.vault.text('m.md');
    await until(done, 15000);
    expect(done()).toBe(true);
    for (const n of [A, B]) {
      for (let i = 0; i < 30; i++) expect(occurrences(n.vault.text('m.md'), `[b${i}]`)).toBe(1);
    }
  });
});

describe('e2e an attachment changed on both devices at once', { timeout: 40000 }, () => {
  it('keeps the version that loses as a visible conflict copy', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'j.png': Buffer.from([1]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.bin('j.png')?.toString('hex') === '01');
    await sleep(800);
    await Promise.all([A.vault.writeBin('j.png', new Uint8Array([2, 2])), B.vault.writeBin('j.png', new Uint8Array([3, 3, 3]))]);
    const settled = () =>
      copies(ra).length === 1 && copies(rb).length === 1 &&
      A.vault.bin('j.png')?.toString('hex') === B.vault.bin('j.png')?.toString('hex');
    await until(settled, 15000);
    await sleep(1000);
    // Was: both ended with A's bytes, B's only in the version history.
    for (const [r, n] of [[ra, A], [rb, B]] as const) {
      expect(copies(r)).toHaveLength(1);
      const kept = [n.vault.bin('j.png')?.toString('hex'), fs.readFileSync(path.join(r, copies(r)[0])).toString('hex')].sort();
      expect(kept).toEqual(['0202', '030303']);
    }
  });

  it('two devices creating one attachment name at once keep both versions', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1000);
    await Promise.all([A.vault.writeBin('k.png', new Uint8Array([5])), B.vault.writeBin('k.png', new Uint8Array([6, 6]))]);
    const settled = () =>
      copies(ra).length === 1 && copies(rb).length === 1 &&
      A.vault.bin('k.png')?.toString('hex') === B.vault.bin('k.png')?.toString('hex');
    await until(settled, 15000);
    await sleep(1000);
    for (const [r, n] of [[ra, A], [rb, B]] as const) {
      expect(copies(r)).toHaveLength(1);
      const kept = [n.vault.bin('k.png')?.toString('hex'), fs.readFileSync(path.join(r, copies(r)[0])).toString('hex')].sort();
      expect(kept).toEqual(['05', '0606']);
    }
  });
});

describe('e2e an attachment changed here right after a peer\'s version was written', { timeout: 30000 }, () => {
  it('is sent at once, and the peer\'s version written here is not sent back', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1000);
    const received: string[] = [];
    const as = (A.coord as any).binarySync;
    const receive = as._receiveFile.bind(as);
    as._receiveFile = (...args: any[]) => (received.push(args[0]), receive(...args));
    await A.vault.writeBin('j.png', new Uint8Array([1]));
    await until(() => B.vault.bin('j.png')?.toString('hex') === '01');
    await sleep(1000);
    // B's write of A's version is not sent back to A.
    expect(received.filter((p) => p === 'j.png')).toEqual([]);
    // Changed on B 1.2 s after A's version was written there: was only
    // sent at the next file list exchange (none here).
    await sleep(200);
    await B.vault.writeBin('j.png', new Uint8Array([4, 4]));
    await until(() => A.vault.bin('j.png')?.toString('hex') === '0404', 3000);
    expect(A.vault.bin('j.png')?.toString('hex')).toBe('0404');
    await sleep(800);
    expect(B.vault.bin('j.png')?.toString('hex')).toBe('0404');
    expect(copies(ra)).toEqual([]);
    expect(copies(rb)).toEqual([]);
  });
});
