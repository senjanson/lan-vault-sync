/**
 * Stage 1 of the no-loss plan: every step that makes content disappear is
 * checked against what the decision saw, and bulk deletions wait for the user.
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
import { Node, ports, seed, sleep, startNode, tmpRoot, until } from './harness';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

async function restart(n: Node, root: string, id: string, port: number, peers: number[], options: Record<string, unknown> = {}) {
  await n.coord.stop();
  nodes = nodes.filter((x) => x !== n);
  return track(await startNode(root, id, port, peers, {}, options));
}

const copies = (root: string) => fs.readdirSync(root).filter((f) => f.includes('(conflict ')).sort();

describe('no-loss stage 1', { timeout: 40000 }, () => {
  it('T1: keeps a file changed between the file-list decision and the deletion, and gives it back', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'v1', 'p.png': Buffer.from([1, 2]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n.md') === 'v1' && !!B.vault.bin('p.png'));
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);
    await A.vault.rm('n.md');
    await A.vault.rm('p.png');
    await sleep(300);
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    // Between B's decision (from its file list) and the deletion, B edits both.
    const bs = (B.coord as any).binarySync;
    const orig = bs.applyRemoteDelete.bind(bs);
    bs.applyRemoteDelete = async (p: string, record: unknown, ...rest: unknown[]) => {
      if (p === 'n.md') await B.vault.write('n.md', 'v1 edited on B');
      if (p === 'p.png') await B.vault.writeBin('p.png', new Uint8Array([7, 7, 7]));
      return orig(p, record, ...rest);
    };
    await until(() => A.vault.text('n.md') === 'v1 edited on B' && A.vault.bin('p.png')?.toString('hex') === '070707', 15000);
    expect(B.vault.text('n.md')).toBe('v1 edited on B');
    expect(B.vault.bin('p.png')?.toString('hex')).toBe('070707');
    expect(A.vault.text('n.md')).toBe('v1 edited on B');
    expect(A.vault.bin('p.png')?.toString('hex')).toBe('070707');
  });

  it('T2: keeps an edit made just before a peer deleted the note', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'line one\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n.md') === 'line one\n');
    await sleep(800);
    await B.vault.write('n.md', 'line one\nadded on B\n');
    await sleep(20);
    await A.vault.rm('n.md');
    await until(() => A.vault.text('n.md')?.includes('added on B') === true && B.vault.text('n.md')?.includes('added on B') === true, 15000);
    expect(B.vault.text('n.md')).toContain('added on B');
    expect(A.vault.text('n.md')).toContain('added on B');
  });

  it('T3: holds deletions inferred from 90 missing files, then gets them back on request', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i++) files[`f${i}.md`] = `note ${i}`;
    seed(ra, files);
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => fs.readdirSync(rb).filter((n) => n.endsWith('.md')).length === 100, 15000);
    await sleep(1000);
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);
    // A partial copy: 90 notes are missing, though B's records list them.
    for (let i = 10; i < 100; i++) fs.rmSync(path.join(rb, `f${i}.md`));
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.coord.getHeldDeletions().length > 0, 10000);
    await sleep(1500);
    expect(fs.readdirSync(ra).filter((n) => n.endsWith('.md'))).toHaveLength(100);
    const held = B.coord.getHeldDeletions();
    expect(held).toHaveLength(1);
    expect(held[0].kind).toBe('inferred');
    expect(held[0].paths).toHaveLength(90);
    // Held on every round until the user decides.
    await (B.coord as any)._periodicFullSync();
    await sleep(1000);
    expect(fs.readdirSync(ra).filter((n) => n.endsWith('.md'))).toHaveLength(100);
    await B.coord.resolveHeldDeletions(held[0].id, 'keep');
    await until(() => fs.readdirSync(rb).filter((n) => n.endsWith('.md')).length === 100, 15000);
    expect(B.vault.text('f50.md')).toBe('note 50');
    expect(B.coord.getHeldDeletions()).toHaveLength(0);
  });

  it('T3b: deletes inferred files everywhere once the user confirms them', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`f${i}.md`] = `note ${i}`;
    seed(ra, files);
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => fs.readdirSync(rb).filter((n) => n.endsWith('.md')).length === 30, 15000);
    await sleep(1000);
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);
    for (let i = 0; i < 25; i++) fs.rmSync(path.join(rb, `f${i}.md`));
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.coord.getHeldDeletions().length > 0, 10000);
    await B.coord.resolveHeldDeletions(B.coord.getHeldDeletions()[0].id, 'delete');
    // A gets more than half of its vault deleted at once, and asks too.
    await until(() => A.coord.getHeldDeletions().length > 0, 10000);
    expect(A.coord.getHeldDeletions()[0].kind).toBe('incoming');
    await A.coord.resolveHeldDeletions(A.coord.getHeldDeletions()[0].id, 'delete');
    await until(() => fs.readdirSync(ra).filter((n) => n.endsWith('.md')).length === 5, 15000);
    expect(fs.readdirSync(ra).filter((n) => n.endsWith('.md')).sort()).toEqual(['f25.md', 'f26.md', 'f27.md', 'f28.md', 'f29.md']);
  });

  it('T3c: asks before applying a peer deleting more than half of the vault', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.md`] = `note ${i}`;
    seed(ra, files);
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => fs.readdirSync(rb).filter((n) => n.endsWith('.md')).length === 20, 15000);
    await sleep(1000);
    for (let i = 0; i < 15; i++) await A.vault.rm(`f${i}.md`);
    await until(() => B.coord.getHeldDeletions().length > 0, 10000);
    await sleep(500);
    const left = fs.readdirSync(rb).filter((n) => n.endsWith('.md')).length;
    // At most half went before the rest were held.
    expect(left).toBeGreaterThanOrEqual(10);
    const held = B.coord.getHeldDeletions()[0];
    expect(held.kind).toBe('incoming');
    await B.coord.resolveHeldDeletions(held.id, 'delete');
    await until(() => fs.readdirSync(rb).filter((n) => n.endsWith('.md')).length === 5, 10000);
  });

  it('T4: does not overwrite an attachment changed here while the peer version was on its way', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'p.png': Buffer.from([1]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.bin('p.png')?.toString('hex') === '01');
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);
    await sleep(50);
    await A.vault.writeBin('p.png', new Uint8Array([2]));
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    const bs = (B.coord as any).binarySync;
    const orig = bs._receiveFile.bind(bs);
    let once = true;
    bs._receiveFile = async (...args: unknown[]) => {
      if (once && args[0] === 'p.png') {
        once = false;
        await B.vault.writeBin('p.png', new Uint8Array([3, 3]));
      }
      return orig(...args);
    };
    await until(() => !once, 10000);
    await sleep(2000);
    // The version on its way was not written over B's change.
    const refused = B.coord.eventLog.recentRecords().find((r) => r.op === 'precondition-failed' && r.path === 'p.png');
    expect(refused).toBeTruthy();
    // B's change is on disk, or kept where it can be restored. (Which of two
    // diverged attachments wins is settled in stage 2, from their versions.)
    const backups = path.join(rb, '.obsidian/plugins/lan-vault-sync/conflicts');
    const kept = (dir: string): Buffer[] => fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? kept(path.join(dir, e.name)) : e.name === 'p.png' ? [fs.readFileSync(path.join(dir, e.name))] : [])
      : [];
    const versions = [B.vault.bin('p.png'), ...kept(backups)].map((b) => b?.toString('hex'));
    expect(versions).toContain('0303');
    // And it wins, as the later of two changed versions (stage 2).
    expect(B.vault.bin('p.png')?.toString('hex')).toBe('0303');
    expect(A.vault.bin('p.png')?.toString('hex')).toBe('0303');
  });

  it('records remote deletions in the persistent log with rule, peer and hash', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'x.md': 'x', 'k1.md': '1', 'k2.md': '2' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('x.md') === 'x');
    await sleep(800);
    await A.vault.rm('x.md');
    await until(() => !B.vault.exists('x.md'));
    const recs = await B.coord.eventLog.readAll();
    const del = recs.find((r) => r.op === 'delete' && r.path === 'x.md');
    expect(del).toMatchObject({ rule: 'live-delete', before: { size: 1 } });
    expect(del?.peer).toContain('aaaa');
    expect(del?.before?.hash).toBeTruthy();
  });
});

describe('e2e relayed edits of a deleted note', { timeout: 40000 }, () => {
  it('passes an old edit of a note deleted everywhere on once, not round and round', async () => {
    const { connectRaw } = await import('./harness');
    const { encodeYjsSync } = await import('../../src/transport/protocol');
    const { MessageType } = await import('../../src/types');
    const Y = await import('yjs');
    const p = ports();
    const roots = [0, 1, 2].map((i) => tmpRoot('l' + i));
    const ns = [];
    for (let i = 0; i < 3; i++) ns.push(track(await startNode(roots[i], 'node' + i, p + i, [0, 1, 2].filter((j) => j < i).map((j) => p + j))));
    await until(() => ns.every((n) => n.coord.getConnectedPeers().length === 2), 10000);
    await ns[0].vault.write('gone.md', 'old text\n');
    await until(() => ns.every((n) => n.vault.text('gone.md') === 'old text\n'), 10000);
    // The note's history as it was when deleted, as a device that has not
    // heard of the deletion still sends it.
    const dm = (ns[1].coord as any).docManager;
    const late = Y.encodeStateAsUpdate(await dm.getOrCreateDoc('gone.md'));
    await ns[0].vault.deleteFile(ns[0].vault.files.get('gone.md'));
    await until(() => ns.every((n) => !n.vault.exists('gone.md')), 10000);
    await sleep(500);
    let relayed = 0;
    for (const n of ns) {
      const cm = (n.coord as any).connectionManager;
      const send = cm.sendTo.bind(cm);
      cm.sendTo = (id: string, msg: Uint8Array) => { if (msg[0] === MessageType.YJS_UPDATE) relayed++; return send(id, msg); };
    }
    const peer = await connectRaw(p, { deviceId: 'away', vaultId: (ns[0].coord as any).vaultId }, 'TEST-KEY');
    peer.send(encodeYjsSync(MessageType.YJS_UPDATE, 'gone.md', late));
    await sleep(3000);
    peer.ws.close();
    // Each device passes it on at most once, to the two others.
    expect(relayed).toBeLessThanOrEqual(6);
  });
});

describe('no-loss stage 2: attachment versions', { timeout: 60000 }, () => {

  it('T6: a newer attachment edited offline beats an older version another device received later', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    seed(ra, { 'p.png': Buffer.from([1]) });
    const pa = ports();
    let A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.bin('p.png')?.toString('hex') === '01');
    await sleep(500);
    await A.coord.stop();
    nodes = nodes.filter((x) => x !== A);
    // Edited on A while sync was off.
    fs.writeFileSync(path.join(ra, 'p.png'), Buffer.from([2]));
    await sleep(1500);
    // C gets the old version from B, later than A's edit.
    const C0 = track(await startNode(rc, 'cccc', pa + 2, [pa + 1]));
    await until(() => C0.vault.bin('p.png')?.toString('hex') === '01');
    await sleep(500);
    for (const n of [B, C0]) await n.coord.stop();
    nodes = nodes.filter((x) => x !== B && x !== C0);
    const C = track(await startNode(rc, 'cccc', pa + 2, []));
    A = track(await startNode(ra, 'aaaa', pa, [pa + 2]));
    await until(() => C.vault.bin('p.png')?.toString('hex') === '02', 15000);
    await sleep(1500);
    expect(A.vault.bin('p.png')?.toString('hex')).toBe('02');
    expect(C.vault.bin('p.png')?.toString('hex')).toBe('02');
  });

  it('T7: an attachment changed on both devices keeps the later version and the other as a visible copy', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'p.png': Buffer.from([1]) });
    const pa = ports();
    let A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.bin('p.png')?.toString('hex') === '01');
    // Meet again so both record the version they have in common.
    B = await restart(B, rb, 'bbbb', pa + 1, [pa]);
    await sleep(1500);
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);
    await A.vault.writeBin('p.png', new Uint8Array([2]));
    await sleep(1200);
    fs.writeFileSync(path.join(rb, 'p.png'), Buffer.from([3, 3]));
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => A.vault.bin('p.png')?.toString('hex') === '0303' && copies(ra).length === 1 && copies(rb).length === 1, 15000);
    await sleep(1500);
    for (const [r, n] of [[ra, A], [rb, B]] as const) {
      expect(n.vault.bin('p.png')?.toString('hex')).toBe('0303');
      expect(copies(r)).toHaveLength(1);
      expect(fs.readFileSync(path.join(r, copies(r)[0])).toString('hex')).toBe('02');
    }
  });
});

describe('no-loss stage 2: attachment sent live, then changed on one side', { timeout: 40000 }, () => {
  it('takes the change without a copy of the version both had', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1000);
    // Made after the two listed their files: it is sent live only.
    await A.vault.writeBin('p.png', new Uint8Array([1]));
    await until(() => B.vault.bin('p.png')?.toString('hex') === '01');
    await sleep(800);
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);
    fs.writeFileSync(path.join(rb, 'p.png'), Buffer.from([2, 2]));
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => A.vault.bin('p.png')?.toString('hex') === '0202', 15000);
    await sleep(1500);
    // Was: A kept its unchanged version as a visible conflict copy.
    expect(copies(ra)).toEqual([]);
    expect(copies(rb)).toEqual([]);
    expect(B.vault.bin('p.png')?.toString('hex')).toBe('0202');
  });
});

describe('no-loss stage 2: version history', { timeout: 40000 }, () => {
  it('T9: a note emptied by a peer can be restored, and the shrink is recorded', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const long = 'line one of a long note\n'.repeat(20);
    seed(ra, { 'n.md': long });
    const pa = ports();
    // No periodic exchange: the restored text must go out as a change.
    const slow = { syncIntervalMs: 60000 };
    const A = track(await startNode(ra, 'aaaa', pa, [], slow));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa], slow));
    await until(() => B.vault.text('n.md') === long);
    await sleep(800);
    await A.vault.write('n.md', '');
    await until(() => B.vault.text('n.md') === '', 10000);
    await sleep(1500);
    const store = B.coord.versionStore!;
    const entries = await store.list({ path: 'n.md' });
    const texts = await Promise.all(entries.map(async (e) => new TextDecoder().decode((await store.read(e.hash))!)));
    expect(texts).toContain(long);
    const alert = B.coord.eventLog.recentRecords().find((r) => r.op === 'alert' && r.rule === 'content-shrank' && r.path === 'n.md');
    expect(alert).toBeTruthy();
    // Restoring brings the text back, and keeps the empty version first.
    expect(await store.restore(entries.find((e, i) => texts[i] === long)!)).toBe(true);
    // Right away, though B received this very text moments ago: it is not
    // B's own write coming back.
    await until(() => B.vault.text('n.md') === long && A.vault.text('n.md') === long, 6000);
    expect(B.vault.text('n.md')).toBe(long);
    expect(A.vault.text('n.md')).toBe(long);
  });
});

describe('no-loss stage 2: suspicious reads', { timeout: 40000 }, () => {
  it('does not send a note cut short while the app was closed, and writes it back whole', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const long = Array.from({ length: 40 }, (_, i) => `line ${i} of the note\n`).join('');
    seed(ra, { 'n.md': long });
    const pa = ports();
    let A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n.md') === long);
    await sleep(800);
    await A.coord.stop();
    nodes = nodes.filter((x) => x !== A);
    // A write cut off: the start of the note only.
    fs.writeFileSync(path.join(ra, 'n.md'), long.slice(0, 200));
    A = track(await startNode(ra, 'aaaa', pa, []));
    await sleep(2500);
    expect(B.vault.text('n.md')).toBe(long);
    expect(fs.readFileSync(path.join(ra, 'n.md'), 'utf8')).toBe(long);
  });

  it('reads a note again before taking an empty read as an edit', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'keep me\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n.md') === 'keep me\n');
    await sleep(800);
    let calls = 0;
    const read = (A.coord as any)._readTextFile.bind(A.coord);
    (A.coord as any)._readTextFile = async (p: string) => { const r = await read(p); if (p === 'n.md') calls++; return r; };
    // The storage briefly shows the file empty.
    fs.writeFileSync(path.join(ra, 'n.md'), '');
    A.vault.trigger('modify', A.vault.files.get('n.md'));
    // Back once the change has been read (after the watcher's pause).
    await until(() => calls > 0, 5000);
    await sleep(150);
    fs.writeFileSync(path.join(ra, 'n.md'), 'keep me\n');
    await sleep(2500);
    expect(B.vault.text('n.md')).toBe('keep me\n');
  });
});

describe('no-loss stage 3: monitoring', { timeout: 40000 }, () => {
  it('T11: the event log is still there after a restart', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'a.md': 'a\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('a.md') === 'a\n');
    await A.vault.rm('a.md');
    await until(() => !B.vault.exists('a.md'));
    await sleep(500);
    B = await restart(B, rb, 'bbbb', pa + 1, [pa]);
    const recs = await B.coord.eventLog.readAll();
    expect(recs.some((r) => r.op === 'delete' && r.path === 'a.md' && r.peer?.startsWith('aaaa'))).toBe(true);
  });

  it('T12: a file that stays different for three exchanges shows in the health panel and the status', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'stuck.png': Buffer.from([1, 2, 3]), 'ok.md': 'ok\n' });
    const pa = ports();
    const fast = { health: { stuckMs: 0 } };
    const A = track(await startNode(ra, 'aaaa', pa, [], { syncIntervalMs: 400 }, fast));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa], { syncIntervalMs: 400 }, fast));
    // B cannot take this one file (a full disk, say).
    const bs = (B.coord as any).binarySync;
    const receive = bs._receiveFile.bind(bs);
    bs._receiveFile = async (...a: any[]) => (a.some((x) => x === 'stuck.png' || x?.path === 'stuck.png') ? undefined : receive(...a));
    await until(() => B.coord.health.alerts().some((a) => a.kind === 'file-mismatch'), 15000);
    const alert = B.coord.health.alerts().find((a) => a.kind === 'file-mismatch');
    expect(alert?.msg).toContain('stuck.png');
    expect(B.coord.health.summary(['aaaa']).unsynced).toBe(1);
    const peer = B.coord.health.peers().find((p) => p.id === 'aaaa')!;
    expect(peer.unsynced).toEqual(['stuck.png']);
    expect(B.vault.text('ok.md')).toBe('ok\n');
    // A sees the same from its side.
    await until(() => A.coord.health.summary(['bbbb']).unsynced === 1, 5000);
    expect(A.coord.health.summary(['bbbb']).unsynced).toBe(1);
  });

  it('T13: when the old version cannot be kept, the file is left alone, with an alert and an error in the log', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'a.md': 'keep me\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('a.md') === 'keep me\n');
    await sleep(500);
    const notices: string[] = [];
    B.coord.health.onAlert((a) => notices.push(a.kind));
    B.coord.versionStore!.keep = async () => null;
    await A.vault.rm('a.md');
    await until(() => notices.includes('keep-failed'), 8000);
    await sleep(500);
    expect(B.vault.text('a.md')).toBe('keep me\n');
    expect(notices).toContain('keep-failed');
    expect(B.coord.eventLog.recentRecords().some((r) => r.op === 'error' && r.path === 'a.md' && /could not keep/.test(r.msg ?? ''))).toBe(true);
  });
});

describe('no-loss stage 3: two peers send one new file at once', { timeout: 20000 }, () => {
  it('takes the copies in turn, without a failed write', async () => {
    const rb = tmpRoot('b');
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const bs = (B.coord as any).binarySync;
    const mk = (b: number[]) => new Uint8Array(b);
    await Promise.all([
      bs._receiveFile('new.png', mk([1, 1]), Date.now(), 'aaaa', {}),
      bs._receiveFile('new.png', mk([1, 1]), Date.now(), 'cccc', {}),
    ]);
    expect(B.vault.bin('new.png')?.toString('hex')).toBe('0101');
    // Was: "File already exists" from the second create, logged as a failed write.
    expect(B.coord.eventLog.recentRecords().filter((r) => r.op === 'error')).toEqual([]);
  });
});

describe('no-loss stage 4: deletion records without a hash', { timeout: 20000 }, () => {
  it('keeps an edit that looks older than the deletion, as on a device whose clock is behind', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(rb, { 'x.md': 'edited on B\n' });
    const hourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(rb, 'x.md'), hourAgo, hourAgo);
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    // An old record of A's deletion, from before records carried the hash.
    (A.coord as any).tombstones.add('x.md', undefined, Date.now());
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => A.vault.text('x.md') === 'edited on B\n', 8000);
    await sleep(500);
    // Was: B's copy was older than the deletion by its clock, and deleted.
    expect(B.vault.text('x.md')).toBe('edited on B\n');
    expect(A.vault.text('x.md')).toBe('edited on B\n');
  });
});

describe('no-loss stage 4: vault and device identity', { timeout: 20000 }, () => {
  const V1 = 'v-0123456789abcdef01', V2 = 'v-fedcba987654321001';

  it('syncs devices that share a vault ID, and not a device of another vault', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    seed(ra, { 'a.md': 'a\n' });
    const pa = ports();
    track(await startNode(ra, 'aaaa', pa, [], { vaultId: V1 }));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa], { vaultId: V1 }));
    const C = track(await startNode(rc, 'cccc', pa + 2, [pa], { vaultId: V2 }));
    await until(() => B.vault.text('a.md') === 'a\n');
    await sleep(1000);
    expect(B.vault.text('a.md')).toBe('a\n');
    expect(C.vault.exists('a.md')).toBe(false);
  });

  it('tells when another device uses this device\'s ID', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    const A = track(await startNode(ra, 'same', pa, []));
    const B = track(await startNode(rb, 'same', pa + 1, [pa]));
    const told = (n: Node) => n.coord.eventLog.recentRecords().some((r) => r.rule === 'duplicate-device-id');
    await until(() => told(A) || told(B), 8000);
    expect(told(A) || told(B)).toBe(true);
  });
});
