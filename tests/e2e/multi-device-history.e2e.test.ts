/**
 * Several devices, one of which lost the notes' sync history (crdt-state
 * deleted). What a device last had in common with a peer is kept per peer,
 * and every pair of devices weighs the same two versions of a note alike,
 * so a note changed on one side only leaves no conflict copy and a note
 * changed on both sides leaves exactly one, the same on every device.
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
import { count, Node, ports, seed, sleep, startNode, tmpRoot, until } from './harness';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

const stateDir = '.obsidian/plugins/lan-vault-sync/crdt-state';
const notes = (root: string) => fs.readdirSync(root).filter((f) => f.endsWith('.md')).sort();
const copies = (root: string) => notes(root).filter((f) => f.includes('(conflict '));

/** Four ports, one per device. */
function fourPorts() {
  const p = ports(4);
  return { pa: p, pb: p + 1, pc: p + 2, pd: p + 3 };
}

/** A file list exchange started by `n` with every peer, as the periodic one does; waits for the answers. */
async function listRound(n: Node, peers: Node[]) {
  const before = peers.map((p) => count(p, 'Tree sync with'));
  const own = count(n, 'Tree sync with');
  await (n.coord as any)._periodicFullSync();
  await until(() => peers.every((p, i) => count(p, 'Tree sync with') > before[i]) && count(n, 'Tree sync with') >= own + peers.length);
  await sleep(300);
}

/** Set a note's modified time on a running device (its write time, or a clock that is ahead). */
function setMtime(n: Node, file: string, at: number) {
  fs.utimesSync(path.join(n.vault.root, file), at / 1000, at / 1000);
  n.vault.files.get(file)!.stat.mtime = at;
}

describe('versions shared with peers, saved', { timeout: 20000 }, () => {
  const file = '.obsidian/plugins/lan-vault-sync/agreed-files.json';

  it('keeps each peer\'s versions and learned times across a restart, and forgets peers gone for long', async () => {
    const root = tmpRoot('a');
    seed(root, { 'x.md': 'x\n', 'y.md': 'y\n' });
    const port = ports();
    const A = await startNode(root, 'aaaa', port, []);
    const now = Date.now();
    const c = (A.coord as any).agreed;
    c.byPeer = new Map([
      ['p1', new Map([['x.md', 'h1'], ['y.md', 'h2']])],
      ['p2', new Map([['x.md', 'h1'], ['y.md', 'h3']])],
      ['p3', new Map([['x.md', 'h1']])],
      ['gone', new Map([['x.md', 'h0']])],
    ]);
    c.peerSeen = new Map([['p1', now], ['p2', now], ['p3', now], ['gone', now - 200 * 24 * 3600 * 1000]]);
    c.times = new Map([['x.md', { hash: 'h1', at: 1234 }]]);
    c.changed = true;
    await c.save();
    const saved = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.peers.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2', 'p3', 'gone']);
    // A version shared with every peer is written once.
    expect(saved.files['x.md']).toEqual(['h1', 'h1', 'h1', 'h0']);
    expect(saved.files['y.md']).toEqual(['h2', 'h3', null, null]);
    expect(saved.times['x.md']).toEqual(['h1', 1234]);
    await A.coord.stop();

    const B = await startNode(root, 'aaaa', port, []);
    const d = (B.coord as any).agreed;
    expect([...d.byPeer.keys()]).toEqual(['p1', 'p2', 'p3']);
    expect(Object.fromEntries(d.byPeer.get('p1'))).toEqual({ 'x.md': 'h1', 'y.md': 'h2' });
    expect(Object.fromEntries(d.byPeer.get('p2'))).toEqual({ 'x.md': 'h1', 'y.md': 'h3' });
    expect(Object.fromEntries(d.byPeer.get('p3'))).toEqual({ 'x.md': 'h1' });
    expect(d.times.get('x.md')).toEqual({ hash: 'h1', at: 1234 });
    d.byPeer.delete('p3');
    d.changed = true;
    await d.save();
    expect(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).files['x.md']).toBe('h1');
    await B.coord.stop();

    // The earlier form, one hash per note, does not say which peer had it.
    fs.writeFileSync(path.join(root, file), JSON.stringify({ 'x.md': 'h1' }));
    const C = await startNode(root, 'aaaa', port, []);
    expect((C.coord as any).agreed.byPeer.size).toBe(0);
    await C.coord.stop();
  });
});

describe('e2e lost sync history with several devices', { timeout: 40000 }, () => {
  it('keeps no copy when the others moved on without the device that lost its history', async () => {
    const roots = { a: tmpRoot('a'), b: tmpRoot('b'), c: tmpRoot('c'), d: tmpRoot('d') };
    const base = { 'a_only.md': 'v1 a_only\n', 'same.md': 'same\n' };
    for (const r of Object.values(roots)) seed(r, base);
    const { pa, pb, pc, pd } = fourPorts();
    const A = track(await startNode(roots.a, 'aaaa', pa, []));
    const C = track(await startNode(roots.c, 'cccc', pc, [pa]));
    const D = track(await startNode(roots.d, 'dddd', pd, [pa, pc]));
    let B = track(await startNode(roots.b, 'bbbb', pb, [pa, pc, pd]));
    await until(() => [A, B, C, D].every((n) => count(n, 'Tree sync with') >= 3));
    await sleep(2000);
    // B goes away and loses its history; A's change reaches the others,
    // which then exchange file lists without B.
    await B.coord.stop();
    nodes = nodes.filter((n) => n !== B);
    fs.rmSync(path.join(roots.b, stateDir), { recursive: true, force: true });
    await A.vault.write('a_only.md', 'v2 a_only from A\n');
    await until(() => [C, D].every((n) => n.vault.text('a_only.md') === 'v2 a_only from A\n'));
    await listRound(A, [C, D]);
    await listRound(C, [A, D]);
    B = track(await startNode(roots.b, 'bbbb', pb, [pa, pc, pd]));
    const all = [A, B, C, D];
    await until(() => all.every((n) => n.vault.text('a_only.md') === 'v2 a_only from A\n') && count(B, 'Tree sync with') >= 3, 10000);
    await sleep(2500);
    for (const n of all) {
      expect(n.vault.text('a_only.md')).toBe('v2 a_only from A\n');
      expect(n.vault.text('same.md')).toBe('same\n');
    }
    for (const r of Object.values(roots)) expect(copies(r)).toEqual([]);
  });

  it('keeps no copy for devices that join after two others settled a note changed on one side', async () => {
    const roots = { a: tmpRoot('a'), b: tmpRoot('b'), c: tmpRoot('c'), d: tmpRoot('d') };
    const base = { 'note.md': 'v1 note\n', 'same.md': 'same\n' };
    for (const r of Object.values(roots)) seed(r, base);
    const { pa, pb, pc, pd } = fourPorts();
    const startAB = async () => [
      track(await startNode(roots.a, 'aaaa', pa, [])),
      track(await startNode(roots.b, 'bbbb', pb, [pa])),
    ];
    const startCD = async () => [
      track(await startNode(roots.c, 'cccc', pc, [pa, pb])),
      track(await startNode(roots.d, 'dddd', pd, [pa, pb, pc])),
    ];
    let [A, B] = await startAB();
    let [C, D] = await startCD();
    await until(() => [A, B, C, D].every((n) => count(n, 'Tree sync with') >= 3));
    await sleep(2000);
    for (const n of [A, B, C, D]) await n.coord.stop();
    nodes = [];
    // B lost its history and changed the note while apart.
    fs.rmSync(path.join(roots.b, stateDir), { recursive: true, force: true });
    seed(roots.b, { 'note.md': 'v2 note from B\n' });
    [A, B] = await startAB();
    await until(() => A.vault.text('note.md') === 'v2 note from B\n');
    await sleep(1000);
    // A and B now have B's version in common; C and D still have v1.
    await listRound(A, [B]);
    [C, D] = await startCD();
    const all = [A, B, C, D];
    await until(() => all.every((n) => n.vault.text('note.md') === 'v2 note from B\n'), 10000);
    await sleep(2500);
    for (const n of all) {
      expect(n.vault.text('note.md')).toBe('v2 note from B\n');
      expect(n.vault.text('same.md')).toBe('same\n');
    }
    for (const r of Object.values(roots)) expect(copies(r)).toEqual([]);
  });

  it('keeps the later edit and one copy everywhere when devices that received the earlier one wrote it later', async () => {
    const roots = { a: tmpRoot('a'), b: tmpRoot('b'), c: tmpRoot('c'), d: tmpRoot('d') };
    const base = { 'both.md': 'v1 both\n', 'same.md': 'same\n' };
    for (const r of Object.values(roots)) seed(r, base);
    const { pa, pb, pc, pd } = fourPorts();
    const A = track(await startNode(roots.a, 'aaaa', pa, []));
    const B = track(await startNode(roots.b, 'bbbb', pb, [pa]));
    const C = track(await startNode(roots.c, 'cccc', pc, [pa, pb]));
    let D = track(await startNode(roots.d, 'dddd', pd, [pa, pb, pc]));
    await until(() => [A, B, C, D].every((n) => count(n, 'Tree sync with') >= 3));
    await sleep(2000);
    // D goes away and loses its history.
    await D.coord.stop();
    nodes = nodes.filter((n) => n !== D);
    fs.rmSync(path.join(roots.d, stateDir), { recursive: true, force: true });
    // A edits; B and C receive it, and their copies look modified later
    // than D's edit below: written after A's edit, by clocks that are ahead.
    await A.vault.write('both.md', 'v2 both from A\n');
    await until(() => [B, C].every((n) => n.vault.text('both.md') === 'v2 both from A\n'));
    await sleep(500);
    const editedOnA = A.vault.files.get('both.md')!.stat.mtime;
    setMtime(B, 'both.md', editedOnA + 8000);
    setMtime(C, 'both.md', editedOnA + 10000);
    await listRound(A, [B, C]);
    // D changed its copy apart, after A's edit.
    seed(roots.d, { 'both.md': 'v2 both from D\n' });
    fs.utimesSync(path.join(roots.d, 'both.md'), (editedOnA + 5000) / 1000, (editedOnA + 5000) / 1000);
    D = track(await startNode(roots.d, 'dddd', pd, [pa, pb, pc]));
    const all = [A, B, C, D];
    const settled = () =>
      all.every((n) => n.vault.text('both.md') === 'v2 both from D\n') &&
      Object.values(roots).every((r) => copies(r).length > 0);
    await until(settled, 12000);
    await sleep(2500);
    for (const n of all) {
      expect(n.vault.text('both.md')).toBe('v2 both from D\n');
      expect(n.vault.text('same.md')).toBe('same\n');
    }
    // A's version is kept once, as the same copy on every device.
    for (const r of Object.values(roots)) {
      expect(copies(r)).toHaveLength(1);
      expect(fs.readFileSync(path.join(r, copies(r)[0]), 'utf8')).toBe('v2 both from A\n');
    }
  });

  it('keeps the later edit and one copy when a hub passes on a history while its other peers still hold the old one', async () => {
    // Several notes: the histories' client IDs are random, and which one an
    // undecided pair kept depended on them.
    const n = 6;
    const names = [...Array(n).keys()].map((k) => `both${k}.md`);
    const roots = { a: tmpRoot('a'), b: tmpRoot('b'), c: tmpRoot('c'), d: tmpRoot('d') };
    const base: Record<string, string> = { 'same.md': 'same\n' };
    for (const f of names) base[f] = `v1 ${f}\n`;
    for (const r of Object.values(roots)) seed(r, base);
    const { pa, pb, pc, pd } = fourPorts();
    // A is the hub: the others connect to it only, like phones to a desktop.
    const A = track(await startNode(roots.a, 'aaaa', pa, []));
    const B = track(await startNode(roots.b, 'bbbb', pb, [pa]));
    const C = track(await startNode(roots.c, 'cccc', pc, [pa]));
    let D = track(await startNode(roots.d, 'dddd', pd, [pa]));
    await until(() => count(A, 'Tree sync with') >= 3 && [B, C, D].every((x) => count(x, 'Tree sync with') >= 1));
    await sleep(2000);
    // D goes away and loses its history.
    await D.coord.stop();
    nodes = nodes.filter((x) => x !== D);
    fs.rmSync(path.join(roots.d, stateDir), { recursive: true, force: true });
    // A edits; B and C receive the edits live, and no file lists are
    // exchanged after that: the version A last had in common with them is
    // still v1.
    for (const f of names) await A.vault.write(f, `v2 ${f} from A\n`);
    await until(() => [B, C].every((x) => names.every((f) => x.vault.text(f) === `v2 ${f} from A\n`)));
    await sleep(500);
    const editedOnA = Math.max(...names.map((f) => A.vault.files.get(f)!.stat.mtime));
    // D changed its copies apart, later (by a clock that is ahead, too).
    for (const f of names) {
      seed(roots.d, { [f]: `v2 ${f} from D\n` });
      fs.utimesSync(path.join(roots.d, f), (editedOnA + 4000) / 1000, (editedOnA + 4000) / 1000);
    }
    D = track(await startNode(roots.d, 'dddd', pd, [pa]));
    const all = [A, B, C, D];
    const settled = () =>
      all.every((x) => names.every((f) => x.vault.text(f) === `v2 ${f} from D\n`)) &&
      Object.values(roots).every((r) => copies(r).length >= n);
    await until(settled, 12000);
    await sleep(1500);
    // A file list exchange settles whatever the histories left apart, as
    // the periodic one does.
    await listRound(A, [B, C, D]);
    await until(settled, 8000);
    await sleep(1500);
    for (const x of all) {
      for (const f of names) expect(x.vault.text(f)).toBe(`v2 ${f} from D\n`);
      expect(x.vault.text('same.md')).toBe('same\n');
    }
    // A's versions are kept once each, the same copies on every device;
    // never a copy of D's version, which is in the notes.
    for (const r of Object.values(roots)) {
      const kept = copies(r).map((f) => fs.readFileSync(path.join(r, f), 'utf8')).sort();
      expect(kept).toEqual(names.map((f) => `v2 ${f} from A\n`).sort());
    }
  });

  /**
   * Notes made on A reach B and C live; then B leaves and loses its
   * history, and the notes are changed apart. What A and B last had in
   * common is recorded only from file lists (see
   * SyncCoordinator._noteAgreedHashes), so it is known only when a list
   * exchange came between the notes reaching B and B leaving.
   */
  async function notesChangedAfterLiveSync(listsExchanged: boolean) {
    const roots = { a: tmpRoot('a'), b: tmpRoot('b'), c: tmpRoot('c') };
    const p = ports();
    const [pa, pb, pc] = [p, p + 1, p + 2];
    const A = track(await startNode(roots.a, 'aaaa', pa, []));
    let B = track(await startNode(roots.b, 'bbbb', pb, [pa]));
    const C = track(await startNode(roots.c, 'cccc', pc, [pa]));
    await until(() => count(A, 'Tree sync with') >= 2 && [B, C].every((x) => count(x, 'Tree sync with') >= 1));
    const made = ['only-hub-edits.md', 'only-other-edits.md', 'both-edit.md'];
    for (const f of made) await A.vault.write(f, 'line1\n');
    await until(() => [B, C].every((x) => made.every((f) => x.vault.text(f) === 'line1\n')));
    await sleep(500);
    if (listsExchanged) await listRound(A, [B, C]);
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);
    fs.rmSync(path.join(roots.b, stateDir), { recursive: true, force: true });
    await A.vault.write('only-hub-edits.md', 'line1\nfrom A\n');
    await A.vault.write('both-edit.md', 'line1\nboth, from A\n');
    await until(() => C.vault.text('both-edit.md') === 'line1\nboth, from A\n');
    const at = Date.now() + 3000;
    seed(roots.b, { 'only-other-edits.md': 'line1\nfrom B\n', 'both-edit.md': 'line1\nboth, from B\n' });
    fs.utimesSync(path.join(roots.b, 'both-edit.md'), at / 1000, at / 1000);
    B = track(await startNode(roots.b, 'bbbb', pb, [pa]));
    const all = [A, B, C];
    const expected: Record<string, string> = {
      'only-hub-edits.md': 'line1\nfrom A\n',
      'only-other-edits.md': 'line1\nfrom B\n',
      'both-edit.md': 'line1\nboth, from B\n',
    };
    const contents = () => all.every((x) => Object.entries(expected).every(([f, t]) => x.vault.text(f) === t));
    await until(() => contents() && Object.values(roots).every((r) => copies(r).length > 0), 12000);
    await sleep(2500);
    for (const x of all) for (const [f, t] of Object.entries(expected)) expect(x.vault.text(f)).toBe(t);
    return Object.values(roots).map((r) =>
      copies(r).map((f) => `${f.replace(/ \(conflict \w+\)/, '')}: ${JSON.stringify(fs.readFileSync(path.join(r, f), 'utf8'))}`).sort(),
    );
  }

  it('keeps a copy only of the note changed on both sides when lists were exchanged after the notes were made', async () => {
    for (const kept of await notesChangedAfterLiveSync(true)) {
      expect(kept).toEqual(['both-edit.md: "line1\\nboth, from A\\n"']);
    }
  });

  it('keeps the original of notes changed on one side as copies when no lists were exchanged after the notes were made (a known limit)', async () => {
    // Nothing tells that B had the original, so the two versions of each
    // note are weighed as changed on both sides: the later one wins and the
    // other is kept. Nothing is lost; the copies are extra. The periodic
    // list exchange (every 30 s by default) closes this window; an extra
    // exchange after each burst of live changes would only narrow it, at
    // the cost of sending whole file lists at every pause in typing.
    for (const kept of await notesChangedAfterLiveSync(false)) {
      expect(kept).toEqual([
        'both-edit.md: "line1\\nboth, from A\\n"',
        'only-hub-edits.md: "line1\\n"',
        'only-other-edits.md: "line1\\n"',
      ]);
    }
  });
});

describe('separate histories that both devices keep', { timeout: 20000 }, () => {
  it('does not trade the two docs back and forth', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'same text\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n.md') === 'same text\n');
    await sleep(1000);
    // Each side holds a decision to keep its own doc (one left over from a
    // file list the other has since replaced, say), and B's doc is another
    // history of the note.
    const a = A.coord as any, b = B.coord as any;
    a.historyWinners.set('bbbb\nn.md', { localWins: true, keepCopy: false });
    b.historyWinners.set('aaaa\nn.md', { localWins: true, keepCopy: false });
    await b.docManager.removeDoc('n.md');
    const before = count(A, 'Resolving unrelated history') + count(B, 'Resolving unrelated history');
    await b._sendFullTextState('aaaa', 'n.md', 'event.sending-text');
    await sleep(2000);
    const sent = count(A, 'Resolving unrelated history') + count(B, 'Resolving unrelated history') - before;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(2);
    for (const n of [A, B]) expect(n.vault.text('n.md')).toBe('same text\n');
  });
});
