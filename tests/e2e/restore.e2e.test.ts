/**
 * Restoring from the version store while file lists are exchanged: a
 * restored file must not be taken for the deleted copy a peer's deletion
 * record describes, and must reach the peers.
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
import { Node, ports, seed, sleep, startNode, tmpRoot, until } from './harness';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

const notes = (root: string) => fs.readdirSync(root).filter((n) => /^n\d+\.md$/.test(n));

describe('restore from the version store', { timeout: 60000 }, () => {
  it('a group restored while file lists are exchanged is not deleted again, and reaches the peer', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const N = 60;
    const files: Record<string, string> = { 'keep.md': 'stays\n' };
    for (let i = 0; i < N; i++) files[`n${i}.md`] = `note ${i}\n`;
    seed(ra, files);
    const pa = ports();
    // A peer deleting every note is not held here: the restore is the subject.
    const opts = { deleteLimits: { incomingShare: 10 } };
    const A = track(await startNode(ra, 'aaaa', pa, [], {}, opts));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa], {}, opts));
    await until(() => notes(rb).length === N, 20000);
    await sleep(1000);
    for (let i = 0; i < N; i++) await A.vault.rm(`n${i}.md`);
    await until(() => notes(rb).length === 0, 20000);
    expect(notes(rb)).toHaveLength(0);
    await sleep(1500);

    // B works through its file events slowly, as a phone does when it
    // writes hundreds of files: each restored file is in the vault well
    // before its create event is handled.
    const bc = B.coord as any;
    const handle = bc._handleLocalFileChange.bind(bc);
    bc._handleLocalFileChange = async (event: { type: string }) => {
      if (event.type === 'create') await sleep(100);
      return handle(event);
    };
    // The log keeps only its latest records in memory, and the exchanges
    // below fill it: deletions are collected as they are recorded.
    const deletedAgain: string[] = [];
    const record = B.coord.eventLog.record.bind(B.coord.eventLog);
    B.coord.eventLog.record = (rec) => {
      if (rec.op === 'delete' && rec.path) deletedAgain.push(`${rec.path} ${rec.rule}`);
      return record(rec);
    };
    // File lists go both ways about every 100 ms throughout.
    const exchange = setInterval(() => {
      void (A.coord as any)._periodicFullSync().catch(() => undefined);
      void bc._periodicFullSync().catch(() => undefined);
    }, 100);
    try {
      const store = B.coord.versionStore!;
      await store.flush();
      const group = (await store.groups()).find((g) => g.ops.includes('remote-file-delete'))!;
      expect(group.entries.filter((e) => /^n\d+\.md$/.test(e.path))).toHaveLength(N);
      const { restored, failed } = await store.restoreGroup(group.entries);
      expect(failed).toEqual([]);
      expect(restored).toHaveLength(N);
      await until(() => notes(ra).length === N, 30000);
      await sleep(3000);
    } finally {
      clearInterval(exchange);
    }
    // Was: some of them were deleted again on B by A's deletion record
    // (tombstone-covers), before B's create events marked them as put back.
    expect(deletedAgain).toEqual([]);
    expect(notes(rb)).toHaveLength(N);
    expect(notes(ra)).toHaveLength(N);
    expect(A.vault.text('n7.md')).toBe('note 7\n');
  });

  it('a restored file whose deletion this device has no record of reaches the peer that deleted it', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'keep.md': 'stays\n', 'n1.md': 'note 1\n', 'p.png': Buffer.from([1, 2, 3]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n1.md') === 'note 1\n' && !!B.vault.bin('p.png'), 15000);
    await sleep(1000);
    await A.vault.rm('n1.md');
    await A.vault.rm('p.png');
    await until(() => !B.vault.exists('n1.md') && !B.vault.exists('p.png'), 15000);
    await sleep(1500);
    // B's own records of these deletions are gone (expired, or lost).
    (B.coord as any).tombstones.clear('n1.md');
    (B.coord as any).tombstones.clear('p.png');
    const store = B.coord.versionStore!;
    await store.flush();
    const entries = (await store.list()).filter((e) => e.op === 'remote-file-delete');
    const { failed } = await store.restoreGroup(entries);
    expect(failed).toEqual([]);
    for (let i = 0; i < 6; i++) {
      await (A.coord as any)._periodicFullSync();
      await (B.coord as any)._periodicFullSync();
      await sleep(400);
    }
    await until(() => A.vault.text('n1.md') === 'note 1\n' && !!A.vault.bin('p.png'), 10000);
    // Was: A's deletion record matched the restored content, and B deleted it again.
    expect(B.vault.text('n1.md')).toBe('note 1\n');
    expect(B.vault.bin('p.png')?.toString('hex')).toBe('010203');
    expect(A.vault.text('n1.md')).toBe('note 1\n');
    expect(A.vault.bin('p.png')?.toString('hex')).toBe('010203');
  });
});
