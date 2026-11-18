/**
 * Plan 6.1: the plugin's state files are written so that a crash or power
 * loss mid-save never leaves a broken file in place of a good one, and a
 * damaged file is read from its backup, with a warning for the user.
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
import { FILE_INDEX_FILE } from '../../src/constants';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

describe('state files', { timeout: 40000 }, () => {
  it('reads a damaged list of synced files from its backup and warns', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'v1', 'p.png': Buffer.from([1, 2]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n.md') === 'v1' && !!B.vault.bin('p.png'));
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);

    // A good backup next to a main file that a power loss left half written.
    const main = path.join(rb, FILE_INDEX_FILE);
    const saved = fs.readFileSync(main, 'utf8');
    expect(JSON.parse(saved)).toHaveProperty('n.md');
    fs.writeFileSync(`${main}.bak`, saved);
    fs.writeFileSync(main, '{"n.md": "abc', 'utf8');

    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    expect(B.coord.health.alerts().some((a) => a.kind === 'state-backup-used')).toBe(true);
    // The list was restored from the backup, so the files are known as synced.
    expect((B.coord as any).lastRunFiles.has('n.md')).toBe(true);
    expect((B.coord as any).lastRunFiles.has('p.png')).toBe(true);

    await sleep(1500);
    expect(B.vault.text('n.md')).toBe('v1');
    expect(A.vault.text('n.md')).toBe('v1');
    expect(B.vault.bin('p.png')?.toString('hex')).toBe('0102');
    expect(A.vault.bin('p.png')?.toString('hex')).toBe('0102');
  });
});
