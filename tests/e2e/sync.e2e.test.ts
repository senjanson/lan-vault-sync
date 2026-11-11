/**
 * End-to-end sync scenarios: real WebSocket connections on localhost between
 * several disk-backed test vaults (see harness.ts for the Vault stand-in).
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
import * as Y from 'yjs';
import { encodeFileData, encodeFileRequest, encodeYjsSync } from '../../src/transport/protocol';
import { MessageType } from '../../src/types';
import { connectRaw, count, Node, ports, seed, sleep, startNode, tmpRoot } from './harness';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

describe('e2e sync', { timeout: 30000 }, () => {
  it('connects once and syncs a small vault (handshake ack race)', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    // The listening side has an empty vault, so its file tree goes out right
    // behind the handshake ack (both tend to arrive in one TCP chunk).
    seed(rb, { '日记/第一 篇.md': '你好', 'a b/c.md': 'hello', 'img/图.png': Buffer.from([1, 2, 0, 255]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(2500);
    expect(A.vault.text('日记/第一 篇.md')).toBe('你好');
    expect(A.vault.text('a b/c.md')).toBe('hello');
    expect(A.vault.bin('img/图.png')?.toString('hex')).toBe('010200ff');
    expect(count(B, 'Connected to')).toBe(1);
    expect(count(A, 'Disconnected')).toBe(0);
  });
});

describe('e2e connections', { timeout: 30000 }, () => {
  it('keeps one working connection when a manual peer is also auto-discovered', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports(), pb = pa + 1;
    const B = track(await startNode(rb, 'bbbb', pb, []));
    const A = track(await startNode(ra, 'aaaa', pa, [pb]));
    // Discovery reports the same device while the manual connection is still opening.
    (A.coord as any).discovery._handleDeviceSeen({
      deviceId: 'bbbb', deviceName: 'bbbb', ip: '127.0.0.1', port: pb,
      vaultId: (A.coord as any).vaultId, lastSeen: Date.now(), acceptsIncomingConnections: true,
    });
    await sleep(2000);
    expect(A.coord.getConnectedDevices()).toEqual(['bbbb']);
    await A.vault.write('after.md', 'hello from A');
    await sleep(800);
    expect(B.vault.text('after.md')).toBe('hello from A');
    expect(count(A, 'Disconnected')).toBe(0);
  });

  it('stops reconnecting after the sync service is stopped', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'after-stop.md': 'must not sync after stop' });
    const pa = ports(), pb = pa + 1;
    const A = await startNode(ra, 'aaaa', pa, [pb]); // B is offline, A keeps retrying
    await sleep(300);
    await A.coord.stop();
    const B = track(await startNode(rb, 'bbbb', pb, []));
    await sleep(4000);
    expect(B.coord.getConnectedDevices()).toEqual([]);
    expect(B.vault.text('after-stop.md')).toBeNull();
  });
});

describe('e2e settings', { timeout: 30000 }, () => {
  it('starts and syncs even when a saved manual peer address is invalid', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'hi' });
    const pa = ports(), pb = pa + 1;
    track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pb, [], {
      manualPeers: ['192.168.1.5:abc', `127.0.0.1:${pa}`],
    }));
    await sleep(1500);
    expect(B.coord.getState()).toBe('watching');
    expect(B.vault.text('n.md')).toBe('hi');
  });
});

describe('e2e file writes', { timeout: 30000 }, () => {
  it('does not rewrite files whose content is already identical', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'same.md': 'identical' });
    seed(rb, { 'same.md': 'identical' });
    const old = new Date('2020-01-01');
    for (const r of [ra, rb]) fs.utimesSync(path.join(r, 'same.md'), old, old);
    const pa = ports();
    track(await startNode(ra, 'aaaa', pa, []));
    track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1500);
    for (const r of [ra, rb]) expect(fs.statSync(path.join(r, 'same.md')).mtime.getFullYear()).toBe(2020);
  });
});

describe('e2e paths', { timeout: 30000 }, () => {
  it('syncs names that contain ".." inside a segment', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'v1..2.md': 'dots', 'img/a..b.png': Buffer.from([7]) });
    const pa = ports();
    track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1500);
    expect(B.vault.text('v1..2.md')).toBe('dots');
    expect(B.vault.exists('img/a..b.png')).toBe(true);
  });

  it('refuses writes into the hidden .obsidian folder', async () => {
    const ra = tmpRoot('a');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const rogue = await connectRaw(pa, { deviceId: 'rogue', vaultId: (A.coord as any).vaultId });
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'console.log("pwned")');
    rogue.send(encodeYjsSync(MessageType.YJS_UPDATE, '.obsidian/plugins/evil/main.js', Y.encodeStateAsUpdate(doc)));
    rogue.send(encodeFileData({ path: '.obsidian/community-plugins.json', content: new TextEncoder().encode('["evil"]'), mtime: 1 }));
    await sleep(800);
    rogue.ws.close();
    expect(fs.existsSync(path.join(ra, '.obsidian/plugins/evil/main.js'))).toBe(false);
    expect(fs.existsSync(path.join(ra, '.obsidian/community-plugins.json'))).toBe(false);
  });
});

describe('e2e ignored paths', { timeout: 30000 }, () => {
  it('does not pull or serve files in ignored paths', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'private/mine.md': 'A secret', 'private/mine.png': Buffer.from([1]) });
    seed(rb, { 'private/secret.md': 'B secret', 'private/p.png': Buffer.from([5]) });
    const pa = ports();
    const ignore = { ignoredPaths: ['.obsidian/', '.trash/', 'private/'] };
    const A = track(await startNode(ra, 'aaaa', pa, [], ignore));
    track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1500);
    expect(A.vault.text('private/secret.md')).toBeNull();
    expect(A.vault.exists('private/p.png')).toBe(false);

    // A peer that asks for ignored files directly gets nothing.
    const rogue = await connectRaw(pa, { deviceId: 'rogue', vaultId: (A.coord as any).vaultId });
    rogue.send(encodeFileRequest('private/mine.png'));
    rogue.send(encodeYjsSync(MessageType.YJS_SYNC_STEP1, 'private/mine.md', Y.encodeStateVector(new Y.Doc())));
    await sleep(800);
    rogue.ws.close();
    const types = rogue.received.map((m) => m.type);
    expect(types).not.toContain(MessageType.FILE_DATA);
    expect(types).not.toContain(MessageType.YJS_SYNC_STEP2);
  });
});

describe('e2e settings changes', { timeout: 30000 }, () => {
  it('applies new ignored paths and peer removal without a restart', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports(), pb = pa + 1;
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pb, [pa]));
    await sleep(1200);
    A.coord.updateIgnoredPaths(['.obsidian/', '.trash/', 'drafts/']);
    await B.vault.write('drafts/d.md', 'draft');
    await B.vault.write('ok.md', 'ok');
    await sleep(800);
    expect(A.vault.text('ok.md')).toBe('ok');
    expect(A.vault.text('drafts/d.md')).toBeNull();

    B.coord.removeManualPeer(`127.0.0.1:${pa}`);
    await sleep(2500);
    expect(B.coord.getConnectedDevices()).toEqual([]);
    expect(A.coord.getConnectedDevices()).toEqual([]);
  });
});

describe('e2e long names', { timeout: 30000 }, () => {
  it('merges offline edits of a note with a long Chinese name', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const long = '读书笔记/' + '这是一个比较长的中文文件名用于测试同步插件'.repeat(3) + '.md';
    seed(ra, { [long]: 'L1\nL2\nL3\n' });
    const pa = ports(), pb = pa + 1;
    let A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pb, [pa]));
    await sleep(1200);
    await A.vault.write(long, 'L1\nL2\nL3\nL4\n');
    await sleep(800);
    await A.coord.stop();
    await B.coord.stop();
    nodes = [];
    // Both sides edit a different line while disconnected.
    seed(ra, { [long]: 'L1 A\nL2\nL3\nL4\n' });
    seed(rb, { [long]: 'L1\nL2\nL3 B\nL4\n' });
    A = track(await startNode(ra, 'aaaa', pa, []));
    B = track(await startNode(rb, 'bbbb', pb, [pa]));
    await sleep(2000);
    expect(A.vault.text(long)).toBe('L1 A\nL2\nL3 B\nL4\n');
    expect(B.vault.text(long)).toBe('L1 A\nL2\nL3 B\nL4\n');
  });
});

describe('e2e edits right after a remote write', { timeout: 30000 }, () => {
  it('syncs a local edit made within seconds of receiving a remote change', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'L1\nL2\nL3\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1500);
    await A.vault.write('n.md', 'L1 A\nL2\nL3\n');
    await sleep(500); // B has just written A's change
    await B.vault.write('n.md', 'L1 A\nL2\nL3 B\n');
    await sleep(1000);
    expect(A.vault.text('n.md')).toBe('L1 A\nL2\nL3 B\n');
    await A.vault.write('n.md', 'L1 A\nL2 A\nL3 B\n');
    await sleep(800);
    expect(B.vault.text('n.md')).toBe('L1 A\nL2 A\nL3 B\n');
  });
});

describe('e2e large files', { timeout: 60000 }, () => {
  it('syncs a binary file larger than 100 MB without dropping the connection', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const big = Buffer.alloc(101 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    seed(ra, { 'video.mp4': big, 'small.md': 'hi' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(8000);
    expect(B.vault.bin('video.mp4')?.equals(big)).toBe(true);
    expect(B.vault.text('small.md')).toBe('hi');
    expect(count(A, 'Disconnected') + count(B, 'Disconnected')).toBe(0);
  });
});

describe('e2e unrelated histories', { timeout: 30000 }, () => {
  it('does not duplicate text when a new device joins with a copy of the vault', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    seed(ra, { 'x.md': 'Hello\n' });
    const pa = ports(), pb = pa + 1, pc = pa + 2;
    const A = track(await startNode(ra, 'mmmm', pa, []));
    const B = track(await startNode(rb, 'zzzz', pb, [pa]));
    await sleep(1500);
    await A.vault.write('x.md', 'Hello\nworld\n');
    await sleep(1000);
    // C starts from a copied folder with a fresh plugin install.
    seed(rc, { 'x.md': 'Hello\nworld\n' });
    const C = track(await startNode(rc, '0000', pc, [pa]));
    await sleep(2500);
    for (const n of [A, B, C]) expect(n.vault.text('x.md')).toBe('Hello\nworld\n');
    // Edits still flow both ways afterwards.
    await C.vault.write('x.md', 'Hello\nworld\nfrom C\n');
    await sleep(1000);
    for (const n of [A, B, C]) expect(n.vault.text('x.md')).toBe('Hello\nworld\nfrom C\n');
  });

  it('does not duplicate text when only one side has CRDT history', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'x.md': 'v1\n' });
    const pa = ports(), pb = pa + 1;
    let A = track(await startNode(ra, 'aaaa', pa, []));
    await A.vault.write('x.md', 'v1\nedited on A\n');
    await sleep(600);
    await A.coord.stop();
    nodes = [];
    await sleep(50);
    seed(rb, { 'x.md': 'v1\nedited on B\n' });
    A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pb, [pa]));
    await sleep(2500);
    const a = A.vault.text('x.md');
    expect(a).toBe(B.vault.text('x.md'));
    expect(['v1\nedited on A\n', 'v1\nedited on B\n']).toContain(a);
  });
});

describe('e2e offline deletes', { timeout: 30000 }, () => {
  async function pair(ra: string, rb: string, pa: number) {
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    return { A, B };
  }

  it('does not bring back files deleted or renamed while a peer was offline', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'keep.md': 'k', 'gone.md': 'delete me', 'g.png': Buffer.from([1]), 'old.md': 'moved' });
    const pa = ports();
    let { A, B } = await pair(ra, rb, pa);
    await sleep(1500);
    expect(B.vault.text('gone.md')).toBe('delete me');
    await B.coord.stop();
    nodes = nodes.filter((n) => n !== B);
    await A.vault.rm('gone.md');
    await A.vault.rm('g.png');
    await A.vault.mv('old.md', 'new.md');
    await sleep(500);
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(2000);
    for (const n of [A, B]) {
      expect(n.vault.exists('gone.md')).toBe(false);
      expect(n.vault.exists('g.png')).toBe(false);
      expect(n.vault.exists('old.md')).toBe(false);
      expect(n.vault.text('new.md')).toBe('moved');
      expect(n.vault.text('keep.md')).toBe('k');
    }
  });

  it('applies a deletion made by the device that was offline', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'gone.md': 'delete me' });
    const pa = ports();
    let { A, B } = await pair(ra, rb, pa);
    await sleep(1500);
    await A.coord.stop();
    nodes = nodes.filter((n) => n !== A);
    await B.vault.rm('gone.md');
    await sleep(300);
    // Restart B too, so the deletion has to survive a restart.
    await B.coord.stop();
    nodes = [];
    A = track(await startNode(ra, 'aaaa', pa, []));
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(2000);
    expect(A.vault.exists('gone.md')).toBe(false);
    expect(B.vault.exists('gone.md')).toBe(false);
  });

  it('keeps a file the offline peer edited after it was deleted', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'v1' });
    const pa = ports();
    let { A, B } = await pair(ra, rb, pa);
    await sleep(1500);
    await B.coord.stop();
    nodes = nodes.filter((n) => n !== B);
    await A.vault.rm('n.md');
    await sleep(300);
    seed(rb, { 'n.md': 'v1 edited later' });
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(2000);
    expect(A.vault.text('n.md')).toBe('v1 edited later');
    expect(B.vault.text('n.md')).toBe('v1 edited later');
  });
});
