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
    expect(B.vault.bin('p.png')?.toString('hex')).toBe('0303');
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
