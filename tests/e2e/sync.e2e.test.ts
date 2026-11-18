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
import { TFolder } from 'obsidian';
import { decodeMessage, encodeFileData, encodeFileDelete, encodeFileRequest, encodeYjsSync } from '../../src/transport/protocol';
import { computeFileHash } from '../../src/binary-sync/file-hash';
import { MessageType } from '../../src/types';
import { connectRaw, count, Node, ports, seed, sleep, startNode, tmpRoot, until } from './harness';

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
    await until(() => B.vault.text('after.md') === 'hello from A');
    expect(B.vault.text('after.md')).toBe('hello from A');
    expect(count(A, 'Disconnected')).toBe(0);
  });

  it('says why sync could not start when the port is taken', async () => {
    const pa = ports();
    track(await startNode(tmpRoot('a'), 'aaaa', pa, []));
    const B = track(await startNode(tmpRoot('b'), 'bbbb', pa, []));
    expect(B.coord.getStartError()).toContain(`Port ${pa} is already in use`);
    expect(B.events.join('\n')).toContain(`Port ${pa} is already in use`);
  });

  it('settles on one connection when both devices dial each other at once', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports(), pb = pa + 1;
    const [A, B] = await Promise.all([
      startNode(ra, 'aaaa', pa, [pb]),
      startNode(rb, 'bbbb', pb, [pa]),
    ]);
    track(A); track(B);
    await sleep(4000);
    expect(A.coord.getConnectedDevices()).toEqual(['bbbb']);
    expect(B.coord.getConnectedDevices()).toEqual(['aaaa']);
    // No endless reconnecting: at most the one duplicate was dropped.
    expect(count(A, 'Connected to')).toBeLessThanOrEqual(2);
    await A.vault.write('n.md', 'hello');
    await sleep(800);
    expect(B.vault.text('n.md')).toBe('hello');
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
    await until(() => B.vault.text('n.md') === 'hi');
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
    // Compared as a timestamp: a calendar year depends on the time zone.
    for (const r of [ra, rb]) expect(fs.statSync(path.join(r, 'same.md')).mtimeMs).toBe(old.getTime());
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

  it('closes a connection that sends a lot of data before pairing', async () => {
    const pa = ports();
    track(await startNode(tmpRoot('a'), 'aaaa', pa, []));
    const WS = (globalThis as any).require('ws');
    const ws = new WS(`ws://127.0.0.1:${pa}`);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    let closed = false;
    ws.on('close', () => { closed = true; });
    ws.on('error', () => undefined);
    // A frame that claims 50 MB; the server would buffer it all.
    const header = Buffer.alloc(14);
    header[0] = 0x82; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(50 * 1024 * 1024), 2);
    ws._socket.write(header);
    const chunk = Buffer.alloc(256 * 1024);
    for (let i = 0; i < 12 && !closed; i++) {
      ws._socket.write(chunk);
      await sleep(30);
    }
    await sleep(500);
    expect(closed).toBe(true);
    ws.terminate();
  });

  it('refuses writes into the hidden .obsidian folder', async () => {
    const ra = tmpRoot('a');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const rogue = await connectRaw(pa, { deviceId: 'rogue', vaultId: (A.coord as any).vaultId }, 'TEST-KEY');
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
    const rogue = await connectRaw(pa, { deviceId: 'rogue', vaultId: (A.coord as any).vaultId }, 'TEST-KEY');
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
  it('applies a new sync check interval without a restart', async () => {
    const A = track(await startNode(tmpRoot('a'), 'aaaa', ports(), []));
    const runs = vi.spyOn(A.coord as any, '_periodicFullSync').mockResolvedValue(undefined);
    A.coord.setSyncInterval(100);
    await sleep(450);
    expect(runs.mock.calls.length).toBeGreaterThanOrEqual(3);
    A.coord.setSyncInterval(0);
    const n = runs.mock.calls.length;
    await sleep(300);
    expect(runs.mock.calls.length).toBe(n);
  });

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

describe('e2e edits right before a rename', { timeout: 30000 }, () => {
  it('sends an edit made just before the note was renamed', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'one\n', 'p.png': Buffer.from([1]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n.md') === 'one\n' && B.vault.exists('p.png'));
    // Well within the 200 ms the watcher waits for more changes.
    await A.vault.write('n.md', 'one\ntwo\n');
    await A.vault.writeBin('p.png', Buffer.from([2]));
    await A.vault.mv('n.md', 'm.md');
    await A.vault.mv('p.png', 'q.png');
    await until(() => B.vault.text('m.md') === 'one\ntwo\n' && B.vault.bin('q.png')?.[0] === 2);
    await sleep(500);
    for (const n of [A, B]) {
      expect(n.vault.exists('n.md')).toBe(false);
      expect(n.vault.text('m.md')).toBe('one\ntwo\n');
      expect(n.vault.bin('q.png')?.toString('hex')).toBe('02');
    }
  });

  it('sends a note\'s change that never reached its sync history at the next sync', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'one\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n.md') === 'one\n');
    await A.vault.write('n.md', 'one\ntwo\n');
    await until(() => B.vault.text('n.md') === 'one\ntwo\n');
    // The file changes without an event reaching the plugin.
    fs.writeFileSync(path.join(ra, 'n.md'), 'one\ntwo\nthree\n');
    (A.vault as any).track('n.md');
    await (A.coord as any)._periodicFullSync();
    await until(() => B.vault.text('n.md') === 'one\ntwo\nthree\n');
    expect(B.vault.text('n.md')).toBe('one\ntwo\nthree\n');
    expect(A.vault.text('n.md')).toBe('one\ntwo\nthree\n');
  });
});

describe('e2e names that differ only in case', { timeout: 30000 }, () => {
  /**
   * Make a vault behave like Android's shared storage: names that differ only
   * in case are one file (as on this test disk), and Obsidian there refuses
   * a new name that the storage reports as existing.
   */
  function likeAndroid(n: Node, root: string) {
    const v = n.vault as any;
    const onDisk = (p: string) => fs.existsSync(path.join(root, p));
    const rename = v.rename.bind(v), create = v.create.bind(v), createBinary = v.createBinary.bind(v);
    v.rename = async (f: any, np: string) => { if (np !== f.path && onDisk(np)) throw new Error('Destination file already exists!'); return rename(f, np); };
    v.create = async (p: string, c: string) => { if (onDisk(p)) throw new Error('File already exists.'); return create(p, c); };
    v.createBinary = async (p: string, c: ArrayBuffer) => { if (onDisk(p)) throw new Error('File already exists.'); return createBinary(p, c); };
  }
  const names = (root: string) => fs.readdirSync(root).filter((f) => !f.startsWith('.')).sort();

  it('follows a rename that only changes the case of a name, live and after being apart', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'CaseName.md': 'x\n', 'Pic.png': Buffer.from([1, 2]), 'Later.md': 'later\n', 'Shot.png': Buffer.from([3]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    likeAndroid(B, rb);
    await until(() => B.vault.text('Later.md') === 'later\n' && B.vault.exists('Shot.png') && B.vault.exists('Pic.png'));
    await A.vault.mv('CaseName.md', 'casename.md');
    await A.vault.mv('Pic.png', 'pic.png');
    await until(() => names(rb).includes('casename.md') && names(rb).includes('pic.png'));
    // Apart: B learns of these renames from A's list of deletions.
    await B.coord.stop();
    nodes = nodes.filter((n) => n !== B);
    await A.vault.mv('Later.md', 'later.md');
    await A.vault.mv('Shot.png', 'shot.png');
    await sleep(200);
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    likeAndroid(B, rb);
    await until(() => names(rb).includes('later.md') && names(rb).includes('shot.png'));
    await sleep(500);
    expect(names(rb)).toEqual(['casename.md', 'later.md', 'pic.png', 'shot.png']);
    expect(B.vault.text('casename.md')).toBe('x\n');
    expect(B.vault.text('later.md')).toBe('later\n');
    expect(B.vault.bin('shot.png')?.toString('hex')).toBe('03');
    expect(B.events.filter((e) => e.startsWith('Deleted'))).toEqual([]);
    expect(names(ra)).toEqual(names(rb));
  });

  it('tells once that a peer\'s file cannot be stored next to one whose name differs only in case', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'ReadMe.md': 'mine\n', 'Pic.png': Buffer.from([1]) });
    const pb = ports();
    const B = track(await startNode(rb, 'bbbb', pb, []));
    const { encodeFileMetaSync } = await import('../../src/transport/protocol');
    const hash = await computeFileHash(new TextEncoder().encode('mine\n').buffer as ArrayBuffer);
    const picHash = await computeFileHash(new Uint8Array([1]).buffer as ArrayBuffer);
    const peer = await connectRaw(pb, { deviceId: 'peer', vaultId: (B.coord as any).vaultId }, 'TEST-KEY');
    const tree = encodeFileMetaSync({
      files: [
        { path: 'ReadMe.md', hash, mtime: 1, size: 5, isTextFile: true },
        { path: 'readme.md', hash: 'f'.repeat(64), mtime: 2, size: 7, isTextFile: true },
        { path: 'Pic.png', hash: picHash, mtime: 1, size: 1, isTextFile: false },
        { path: 'pic.png', hash: 'e'.repeat(64), mtime: 2, size: 1, isTextFile: false },
      ],
      folders: [],
      deleted: [],
    });
    for (let round = 0; round < 3; round++) { peer.send(tree); await sleep(300); }
    // The peer sends the file anyway.
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'theirs\n');
    peer.send(encodeYjsSync(MessageType.YJS_FULL_STATE, 'readme.md', Y.encodeStateAsUpdate(doc)));
    peer.send(encodeFileData({ path: 'pic.png', content: new Uint8Array([9]), mtime: 2 }));
    await sleep(500);
    peer.ws.close();
    const asked = peer.received.filter((m) => m.type === MessageType.YJS_SYNC_STEP1 || m.type === MessageType.FILE_REQUEST);
    expect(asked.map((m) => new TextDecoder().decode(m.payload)).join('\n')).not.toMatch(/readme|pic/);
    expect(B.events.filter((e) => e.startsWith('Cannot sync readme.md'))).toHaveLength(1);
    expect(B.events.filter((e) => e.startsWith('Cannot sync pic.png'))).toHaveLength(1);
    expect(names(rb)).toEqual(['Pic.png', 'ReadMe.md']);
    expect(B.vault.text('ReadMe.md')).toBe('mine\n');
    expect(B.vault.bin('Pic.png')?.toString('hex')).toBe('01');
  });
});

describe('e2e text that is not plain UTF-8', { timeout: 30000 }, () => {
  // "中文测试" in GBK, and a UTF-8 file that starts with a byte order mark.
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]);
  const gbk2 = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom text\n')]);
  const hex = (n: Node, p: string) => n.vault.bin(p)?.toString('hex');

  it('syncs such files byte for byte, both ways, at connect and live', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'gbk.txt': gbk, 'bom.md': bom });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => hex(B, 'gbk.txt') === gbk.toString('hex') && hex(B, 'bom.md') === bom.toString('hex'));
    expect(hex(B, 'gbk.txt')).toBe(gbk.toString('hex'));
    expect(hex(B, 'bom.md')).toBe(bom.toString('hex'));
    // Created and changed live, on either side.
    await A.vault.writeBin('live.txt', gbk);
    await until(() => hex(B, 'live.txt') === gbk.toString('hex'));
    await B.vault.writeBin('gbk.txt', gbk2);
    await until(() => hex(A, 'gbk.txt') === gbk2.toString('hex'));
    await sleep(800);
    for (const n of [A, B]) {
      expect(hex(n, 'gbk.txt')).toBe(gbk2.toString('hex'));
      expect(hex(n, 'live.txt')).toBe(gbk.toString('hex'));
      expect(hex(n, 'bom.md')).toBe(bom.toString('hex'));
    }
    // The two agree from then on: a sync finds nothing to do.
    const before = [...A.events, ...B.events].length;
    await (A.coord as any)._periodicFullSync();
    await sleep(800);
    const after = [...A.events, ...B.events].slice(before);
    expect(after.filter((e) => /conflict|Requesting|Sending/i.test(e))).toEqual([]);
  });

  it('switches a file to text sync and back when its encoding changes', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'f.txt': gbk });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => hex(B, 'f.txt') === gbk.toString('hex'));
    // Saved as UTF-8 on A: from then on it merges like any note.
    await A.vault.write('f.txt', '中文测试\n');
    await until(() => B.vault.text('f.txt') === '中文测试\n');
    await sleep(500);
    await A.vault.write('f.txt', '中文测试\nfrom A\n');
    await until(() => B.vault.text('f.txt') === '中文测试\nfrom A\n');
    await B.vault.write('f.txt', 'from B\n中文测试\nfrom A\n');
    await until(() => A.vault.text('f.txt') === 'from B\n中文测试\nfrom A\n');
    // Saved in GBK again on B.
    await sleep(500);
    await B.vault.writeBin('f.txt', gbk2);
    await until(() => hex(A, 'f.txt') === gbk2.toString('hex'));
    await sleep(800);
    expect(hex(A, 'f.txt')).toBe(gbk2.toString('hex'));
    expect(hex(B, 'f.txt')).toBe(gbk2.toString('hex'));
    for (const r of [ra, rb]) expect(fs.readdirSync(r).filter((f) => f.includes('conflict'))).toEqual([]);
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
  it('does not duplicate notes when three devices with the same notes first sync together', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    for (const r of [ra, rb, rc]) seed(r, { 'base.md': 'same\n', 'sub/two.md': 'one\ntwo\n' });
    const pa = ports(), pb = pa + 1, pc = pa + 2;
    const all = await Promise.all([
      startNode(ra, 'aaaa', pa, [pb, pc]),
      startNode(rb, 'bbbb', pb, [pa, pc]),
      startNode(rc, 'cccc', pc, [pa, pb]),
    ]);
    all.forEach(track);
    await sleep(5000);
    for (const n of all) {
      expect(n.vault.text('base.md')).toBe('same\n');
      expect(n.vault.text('sub/two.md')).toBe('one\ntwo\n');
    }
    // Edits still reach everyone.
    await all[2].vault.write('base.md', 'same\nfrom C\n');
    await sleep(1500);
    for (const n of all) expect(n.vault.text('base.md')).toBe('same\nfrom C\n');
  });

  it('keeps both versions when two devices created the same note apart', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'plan.md': 'from A\n' });
    seed(rb, { 'plan.md': 'from B\n' });
    const pa = ports(), pb = pa + 1;
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pb, [pa]));
    await sleep(3500);
    const notes = (root: string) => fs.readdirSync(root).filter((f) => f.endsWith('.md')).sort();
    expect(notes(ra)).toEqual(notes(rb));
    expect(notes(ra)).toHaveLength(2);
    const texts = notes(ra).map((f) => A.vault.text(f)).sort();
    expect(texts).toEqual(['from A\n', 'from B\n']);
    for (const f of notes(ra)) expect(B.vault.text(f)).toBe(A.vault.text(f));
  });

  it('keeps both versions of a note created apart on two of three devices', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    seed(ra, { 'plan.md': 'from A\n' });
    seed(rb, { 'plan.md': 'from B\n' });
    const pa = ports(), pb = pa + 1, pc = pa + 2;
    const all = await Promise.all([
      startNode(ra, 'aaaa', pa, [pb, pc]),
      startNode(rb, 'bbbb', pb, [pa, pc]),
      startNode(rc, 'cccc', pc, [pa, pb]),
    ]);
    all.forEach(track);
    await sleep(5000);
    const roots = [ra, rb, rc];
    const notes = (root: string) => fs.readdirSync(root).filter((f) => f.endsWith('.md')).sort();
    for (const r of roots) expect(notes(r)).toEqual(notes(ra));
    const texts = new Set(notes(ra).map((f) => all[0].vault.text(f)));
    expect([...texts].sort()).toEqual(['from A\n', 'from B\n']);
    for (const n of all) expect(n.vault.text('plan.md')).toBe(all[0].vault.text('plan.md'));
  });
});

describe('e2e lost sync history', { timeout: 30000 }, () => {
  const stateDir = '.obsidian/plugins/lan-vault-sync/crdt-state';
  const listNotes = (root: string) => fs.readdirSync(root).filter((f) => f.endsWith('.md')).sort();

  it('keeps the later edit when one device lost the notes\' sync history', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const base: Record<string, string> = {};
    for (let k = 0; k < 6; k++) base[`n${k}.md`] = `v1 n${k}\n`;
    for (let k = 0; k < 3; k++) base[`same${k}.md`] = `same ${k}\n`;
    seed(ra, base);
    const pa = ports();
    let A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('n5.md') === 'v1 n5\n' && B.vault.text('same2.md') === 'same 2\n');
    await A.coord.stop();
    await B.coord.stop();
    nodes = [];
    // B's saved history is gone (a failed save, say), and B edits later.
    fs.rmSync(path.join(rb, stateDir), { recursive: true, force: true });
    await sleep(50);
    const edited: Record<string, string> = {};
    for (let k = 0; k < 6; k++) edited[`n${k}.md`] = `v1 n${k}\nedited on B\n`;
    seed(rb, edited);
    A = track(await startNode(ra, 'aaaa', pa, []));
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => [A, B].every((n) => [...Array(6).keys()].every((k) => n.vault.text(`n${k}.md`) === edited[`n${k}.md`])), 10000);
    await sleep(1000);
    for (const n of [A, B]) {
      for (let k = 0; k < 6; k++) expect(n.vault.text(`n${k}.md`)).toBe(edited[`n${k}.md`]);
      for (let k = 0; k < 3; k++) expect(n.vault.text(`same${k}.md`)).toBe(`same ${k}\n`);
    }
    // Identical notes never leave a copy; an older version may.
    for (const r of [ra, rb]) {
      for (const f of listNotes(r).filter((f) => f.includes('(conflict'))) {
        expect(f.startsWith('n')).toBe(true);
        expect(fs.readFileSync(path.join(r, f), 'utf8')).toMatch(/^v1 n\d\n$/);
      }
    }
  });

  /** Set a file's modified time to `at` (ms), as a later touch or a skewed clock would. */
  const touch = (root: string, file: string, at: number) => fs.utimesSync(path.join(root, file), at / 1000, at / 1000);
  const copies = (root: string) => listNotes(root).filter((f) => f.includes('(conflict'));

  it('keeps no conflict copy of a note changed on one side only after a device lost its sync history', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const base = {
      'onlyB.md': 'v1 onlyB\n', 'onlyA.md': 'v1 onlyA\n', 'both.md': 'v1 both\n', 'same.md': 'v1 same\n',
      'onlyB touched.md': 'v1 onlyB touched\n', 'onlyA touched.md': 'v1 onlyA touched\n',
    };
    seed(ra, base);
    seed(rb, base);
    const pa = ports();
    let A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => count(A, 'Tree sync with') > 0 && count(B, 'Tree sync with') > 0);
    await sleep(1500);
    await A.coord.stop();
    await B.coord.stop();
    nodes = [];
    // B's saved history is gone (the plugin was reinstalled, say); its list
    // of synced files is still there.
    fs.rmSync(path.join(rb, stateDir), { recursive: true, force: true });
    const now = Date.now();
    seed(rb, { 'onlyB.md': 'v2 onlyB from B\n', 'onlyB touched.md': 'v2 onlyB touched from B\n', 'both.md': 'v2 both from B\n' });
    seed(ra, { 'onlyA.md': 'v2 onlyA from A\n', 'onlyA touched.md': 'v2 onlyA touched from A\n', 'both.md': 'v2 both from A\n' });
    touch(ra, 'both.md', now - 60_000);
    touch(rb, 'both.md', now - 30_000);
    // The unchanged copy was modified later (touched, or a clock that is
    // ahead): the changed copy still wins.
    touch(ra, 'onlyB touched.md', now + 60_000);
    touch(rb, 'onlyA touched.md', now + 60_000);
    A = track(await startNode(ra, 'aaaa', pa, []));
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    const expected: Record<string, string> = {
      'onlyB.md': 'v2 onlyB from B\n', 'onlyA.md': 'v2 onlyA from A\n', 'both.md': 'v2 both from B\n', 'same.md': 'v1 same\n',
      'onlyB touched.md': 'v2 onlyB touched from B\n', 'onlyA touched.md': 'v2 onlyA touched from A\n',
    };
    const settled = () => [A, B].every((n) => Object.entries(expected).every(([f, t]) => n.vault.text(f) === t));
    await until(() => settled() && copies(ra).length > 0 && copies(rb).length > 0, 10000);
    await sleep(1500);
    for (const n of [A, B]) for (const [f, t] of Object.entries(expected)) expect(n.vault.text(f)).toBe(t);
    // Only the note changed on both sides keeps the other version.
    for (const r of [ra, rb]) {
      expect(copies(r)).toHaveLength(1);
      expect(copies(r)[0].startsWith('both (conflict ')).toBe(true);
      expect(fs.readFileSync(path.join(r, copies(r)[0]), 'utf8')).toBe('v2 both from A\n');
    }
    // Edits still flow both ways afterwards.
    await B.vault.write('onlyA.md', 'v3 onlyA from B\n');
    await A.vault.write('onlyB.md', 'v3 onlyB from A\n');
    await until(() => A.vault.text('onlyA.md') === 'v3 onlyA from B\n' && B.vault.text('onlyB.md') === 'v3 onlyB from A\n');
    expect(A.vault.text('onlyA.md')).toBe('v3 onlyA from B\n');
    expect(B.vault.text('onlyB.md')).toBe('v3 onlyB from A\n');
  });

  it('keeps no conflict copy of a note changed on one device after another lost its sync history, with three devices', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    const base = { 'n.md': 'v1 n\n', 'm.md': 'v1 m\n', 'same.md': 'same\n' };
    for (const r of [ra, rb, rc]) seed(r, base);
    const pa = ports(), pb = pa + 1, pc = pa + 2;
    const start = () => Promise.all([
      startNode(ra, 'aaaa', pa, []),
      startNode(rb, 'bbbb', pb, [pa]),
      startNode(rc, 'cccc', pc, [pa, pb]),
    ]);
    let all = await start();
    all.forEach(track);
    await until(() => all.every((n) => count(n, 'Tree sync with') >= 2));
    await sleep(2000);
    for (const n of all) await n.coord.stop();
    nodes = [];
    fs.rmSync(path.join(rb, stateDir), { recursive: true, force: true });
    seed(ra, { 'n.md': 'v2 n from A\n' });
    seed(rb, { 'm.md': 'v2 m from B\n' });
    all = await start();
    all.forEach(track);
    const settled = () => all.every((n) => n.vault.text('n.md') === 'v2 n from A\n' && n.vault.text('m.md') === 'v2 m from B\n');
    await until(settled, 10000);
    await sleep(2000);
    for (const n of all) {
      expect(n.vault.text('n.md')).toBe('v2 n from A\n');
      expect(n.vault.text('m.md')).toBe('v2 m from B\n');
      expect(n.vault.text('same.md')).toBe('same\n');
    }
    for (const r of [ra, rb, rc]) expect(copies(r)).toEqual([]);
  });

  it('keeps the changed version when a device lost all of the plugin\'s data', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const base = { 'onlyB.md': 'v1 onlyB\n', 'onlyA.md': 'v1 onlyA\n', 'same.md': 'v1 same\n' };
    seed(ra, base);
    seed(rb, base);
    const pa = ports();
    let A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => count(A, 'Tree sync with') > 0 && count(B, 'Tree sync with') > 0);
    await sleep(1500);
    await A.coord.stop();
    await B.coord.stop();
    nodes = [];
    // Nothing of the plugin is left on B: it cannot tell which version the
    // two devices last shared, so it keeps the other version as before.
    fs.rmSync(path.join(rb, '.obsidian/plugins/lan-vault-sync'), { recursive: true, force: true });
    await sleep(50);
    seed(rb, { 'onlyB.md': 'v2 onlyB from B\n' });
    seed(ra, { 'onlyA.md': 'v2 onlyA from A\n' });
    A = track(await startNode(ra, 'aaaa', pa, []));
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    const expected: Record<string, string> = { 'onlyB.md': 'v2 onlyB from B\n', 'onlyA.md': 'v2 onlyA from A\n', 'same.md': 'v1 same\n' };
    await until(() => [A, B].every((n) => Object.entries(expected).every(([f, t]) => n.vault.text(f) === t)), 10000);
    await sleep(1500);
    for (const n of [A, B]) for (const [f, t] of Object.entries(expected)) expect(n.vault.text(f)).toBe(t);
    for (const r of [ra, rb]) {
      for (const f of copies(r)) expect(fs.readFileSync(path.join(r, f), 'utf8')).toMatch(/^v1 only[AB]\n$/);
    }
  });
});

describe('e2e files put back after a deletion', { timeout: 30000 }, () => {
  it('keeps a deleted note and attachment that are put back, live', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'f.md': 'keep me\n', 'p.png': Buffer.from([1, 2, 3]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('f.md') === 'keep me\n' && B.vault.exists('p.png'));
    await A.vault.rm('f.md');
    await A.vault.rm('p.png');
    await until(() => !B.vault.exists('f.md') && !B.vault.exists('p.png'));
    await sleep(300);
    // Restored from the trash: the same name and content.
    await A.vault.write('f.md', 'keep me\n');
    await A.vault.writeBin('p.png', Buffer.from([1, 2, 3]));
    await until(() => B.vault.text('f.md') === 'keep me\n' && B.vault.exists('p.png'));
    // A periodic sync later on does not delete them again.
    await (A.coord as any)._periodicFullSync();
    await (B.coord as any)._periodicFullSync();
    await sleep(1500);
    for (const n of [A, B]) {
      expect(n.vault.text('f.md')).toBe('keep me\n');
      expect(n.vault.bin('p.png')?.toString('hex')).toBe('010203');
    }
  });

  it('keeps a note that came from a peer, deleted and put back here', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'f.md': 'keep me\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    // B wrote this text itself, for A's note.
    await until(() => B.vault.text('f.md') === 'keep me\n');
    await B.vault.rm('f.md');
    await until(() => !A.vault.exists('f.md'));
    await sleep(300);
    await B.vault.write('f.md', 'keep me\n');
    await until(() => A.vault.text('f.md') === 'keep me\n');
    await (A.coord as any)._periodicFullSync();
    await (B.coord as any)._periodicFullSync();
    await sleep(1500);
    expect(A.vault.text('f.md')).toBe('keep me\n');
    expect(B.vault.text('f.md')).toBe('keep me\n');
  });

  it('passes a deletion on, so a device behind another gets a note made anew without a copy of the old one', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    seed(ra, { 'f.md': 'old text\n' });
    const pa = ports();
    // B and C are connected through A only, like two phones and a desktop.
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    const C = track(await startNode(rc, 'cccc', pa + 2, [pa]));
    await until(() => B.vault.text('f.md') === 'old text\n' && C.vault.text('f.md') === 'old text\n');
    await sleep(300);
    await C.vault.rm('f.md');
    await C.vault.write('f.md', 'new text\n');
    await until(() => A.vault.text('f.md') === 'new text\n' && B.vault.text('f.md') === 'new text\n');
    await sleep(1500);
    for (const n of [A, B, C]) {
      expect(n.vault.text('f.md')).toBe('new text\n');
      expect(fs.readdirSync(n === A ? ra : n === B ? rb : rc).filter((f) => f.includes('conflict'))).toEqual([]);
    }
  });

  it('keeps a note put back after a deletion that a restarted peer saw while running', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'f.md': 'keep me\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('f.md') === 'keep me\n');
    await sleep(300);
    // B starts again: it remembers that f.md was here when it last ran.
    await B.coord.stop();
    nodes = nodes.filter((n) => n !== B);
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => (A.coord as any).connectionManager.getConnectedPeerIds().length === 1);
    await sleep(500);
    await A.vault.rm('f.md');
    await until(() => !B.vault.exists('f.md'));
    await sleep(300);
    await A.vault.write('f.md', 'keep me\n');
    await until(() => B.vault.text('f.md') === 'keep me\n');
    await (A.coord as any)._periodicFullSync();
    await (B.coord as any)._periodicFullSync();
    await sleep(1500);
    expect(A.vault.text('f.md')).toBe('keep me\n');
    expect(B.vault.text('f.md')).toBe('keep me\n');
  });

  it('keeps a deleted note that is put back while sync is off', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'f.md': 'keep me\n' });
    const pa = ports();
    let A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('f.md') === 'keep me\n');
    await B.vault.rm('f.md');
    await until(() => !A.vault.exists('f.md'));
    await sleep(300);
    await A.coord.stop();
    nodes = nodes.filter((n) => n !== A);
    seed(ra, { 'f.md': 'keep me\n' });
    A = track(await startNode(ra, 'aaaa', pa, []));
    await until(() => B.vault.text('f.md') === 'keep me\n');
    await sleep(1000);
    expect(A.vault.text('f.md')).toBe('keep me\n');
    expect(B.vault.text('f.md')).toBe('keep me\n');
  });

  it('keeps a note made anew under a deleted note\'s name, without a copy of the old one', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const base: Record<string, string> = {};
    for (let k = 0; k < 6; k++) base[`x${k}.md`] = `old ${k}\n`;
    seed(ra, base);
    const pa = ports();
    let A = track(await startNode(ra, 'aaaa', pa, []));
    let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('x5.md') === 'old 5\n');
    await B.coord.stop();
    nodes = nodes.filter((n) => n !== B);
    for (let k = 0; k < 6; k++) await A.vault.rm(`x${k}.md`);
    await sleep(50);
    for (let k = 0; k < 6; k++) await A.vault.write(`x${k}.md`, `new ${k}\n`);
    await sleep(300);
    // B's untouched copies are the newest files on disk.
    const later = new Date(Date.now() + 60_000);
    for (let k = 0; k < 6; k++) fs.utimesSync(path.join(rb, `x${k}.md`), later, later);
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => [...Array(6).keys()].every((k) => B.vault.text(`x${k}.md`) === `new ${k}\n`), 10000);
    await sleep(1000);
    for (const [r, n] of [[ra, A], [rb, B]] as const) {
      for (let k = 0; k < 6; k++) expect(n.vault.text(`x${k}.md`)).toBe(`new ${k}\n`);
      expect(fs.readdirSync(r).filter((f) => f.includes('conflict'))).toEqual([]);
    }
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

  it('keeps an offline edit made before a peer deleted its synced copy', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    let { A, B } = await pair(ra, rb, pa);
    await sleep(1500);
    // Created while connected, so B only knows these from the live updates.
    await A.vault.write('n.md', 'v1');
    await A.vault.writeBin('b.png', Buffer.from([1, 2, 3]));
    await sleep(800);
    expect(B.vault.text('n.md')).toBe('v1');
    await A.coord.stop();
    nodes = nodes.filter((n) => n !== A);
    // A edits while apart; B deletes the copies it received, a bit later.
    seed(ra, { 'n.md': 'v1 edited on A', 'b.png': Buffer.from([4, 5, 6]) });
    await sleep(50);
    await B.vault.rm('n.md');
    await B.vault.rm('b.png');
    await sleep(300);
    A = track(await startNode(ra, 'aaaa', pa, []));
    await sleep(2500);
    expect(A.vault.text('n.md')).toBe('v1 edited on A');
    expect(B.vault.text('n.md')).toBe('v1 edited on A');
    expect(B.vault.bin('b.png')?.toString('hex')).toBe('040506');
  });

  it('applies a note deletion made while sync was not running', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    let { A, B } = await pair(ra, rb, pa);
    await sleep(1500);
    await A.vault.write('gone.md', 'delete me');
    await A.vault.write('edited.md', 'v1');
    await sleep(800);
    expect(B.vault.text('gone.md')).toBe('delete me');
    await B.coord.stop();
    nodes = nodes.filter((n) => n !== B);
    // Deleted outside the plugin, e.g. while the app was closed.
    fs.rmSync(path.join(rb, 'gone.md'));
    fs.rmSync(path.join(rb, 'edited.md'));
    await A.vault.write('edited.md', 'v1 edited on A');
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(2500);
    expect(A.vault.exists('gone.md')).toBe(false);
    expect(B.vault.exists('gone.md')).toBe(false);
    expect(B.vault.text('edited.md')).toBe('v1 edited on A');
  });

  it('applies an attachment deletion made while sync was not running', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    let { A, B } = await pair(ra, rb, pa);
    await sleep(1500);
    await A.vault.writeBin('gone.png', Buffer.from([1, 2, 3]));
    await A.vault.writeBin('changed.png', Buffer.from([4, 5]));
    await sleep(1000);
    expect(B.vault.bin('gone.png')?.length).toBe(3);
    await B.coord.stop();
    nodes = nodes.filter((n) => n !== B);
    fs.rmSync(path.join(rb, 'gone.png'));
    fs.rmSync(path.join(rb, 'changed.png'));
    await A.vault.writeBin('changed.png', Buffer.from([4, 5, 6]));
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(2500);
    expect(A.vault.exists('gone.png')).toBe(false);
    expect(B.vault.exists('gone.png')).toBe(false);
    // Changed on the other device after the deletion: the change wins.
    expect(B.vault.bin('changed.png')?.length).toBe(3);
  });

  it('keeps an offline edit when the deleting peer restarted before deleting', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    let { A, B } = await pair(ra, rb, pa);
    await sleep(1500);
    await A.vault.write('n.md', 'v1');
    await sleep(800);
    expect(B.vault.text('n.md')).toBe('v1');
    await A.coord.stop();
    await B.coord.stop();
    nodes = [];
    // B restarts while A is away, then deletes; A had edited before that.
    B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    seed(ra, { 'n.md': 'v1 edited on A' });
    await sleep(500);
    await B.vault.rm('n.md');
    await sleep(300);
    A = track(await startNode(ra, 'aaaa', pa, []));
    await sleep(2500);
    expect(A.vault.text('n.md')).toBe('v1 edited on A');
    expect(B.vault.text('n.md')).toBe('v1 edited on A');
  });
});

describe('e2e idle traffic', { timeout: 30000 }, () => {
  it('stops sending sync messages once the peers agree', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'L1\nL2\n', 'm.md': 'x' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1500);
    await A.vault.write('n.md', 'L1 A\nL2\n');
    await sleep(1500);
    expect(B.vault.text('n.md')).toBe('L1 A\nL2\n');
    let sent = 0;
    for (const n of [A, B]) {
      const cm = (n.coord as any).connectionManager;
      const sendTo = cm.sendTo.bind(cm);
      cm.sendTo = (id: string, data: Uint8Array) => { sent++; sendTo(id, data); };
    }
    await sleep(1000);
    expect(sent).toBe(0);
  });
});

describe('e2e hub devices', { timeout: 30000 }, () => {
  it('passes edits between two devices that are only connected through a third', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    seed(ra, { 'n.md': 'L1\nL2\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'mmmm', pa, []));
    const B = track(await startNode(rb, 'zzzz', pa + 1, [pa]));
    const C = track(await startNode(rc, '0000', pa + 2, [pa]));
    await sleep(2000);
    await A.vault.write('n.md', 'L1 A\nL2\n');
    await sleep(800);
    await C.vault.write('n.md', 'L1 A\nL2 C\n');
    await sleep(1000);
    expect(A.vault.text('n.md')).toBe('L1 A\nL2 C\n');
    expect(B.vault.text('n.md')).toBe('L1 A\nL2 C\n');
  });
});

describe('e2e pairing key', { timeout: 30000 }, () => {
  it('serves nothing to a device that does not know the sync key', async () => {
    const ra = tmpRoot('a');
    seed(ra, { 'secret.md': 'private', 'p.png': Buffer.from([7]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const rogue = await connectRaw(pa, { deviceId: 'rogue', vaultId: (A.coord as any).vaultId }, 'WRONG-KEY');
    rogue.send(encodeFileRequest('p.png'));
    rogue.send(encodeYjsSync(MessageType.YJS_SYNC_STEP1, 'secret.md', Y.encodeStateVector(new Y.Doc())));
    rogue.send(encodeFileData({ path: 'planted.md', content: new TextEncoder().encode('x'), mtime: Date.now() }));
    await sleep(800);
    const served = rogue.received.filter((m) => m.type !== MessageType.HANDSHAKE_ACK);
    expect(served).toEqual([]);
    expect(rogue.isClosed()).toBe(true);
    expect(A.vault.exists('planted.md')).toBe(false);
    expect(A.coord.getConnectedDevices()).toEqual([]);
  });

  it('does not sync devices with different keys and reports the mismatch', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'hello' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, [], { syncKey: 'KEY-ONE' }));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa], { syncKey: 'KEY-TWO' }));
    await sleep(1500);
    expect(B.vault.exists('n.md')).toBe(false);
    expect(count(B, 'Refused')).toBeGreaterThan(0);
  });

  it('tells the user when a device runs a version without pairing keys', async () => {
    const ra = tmpRoot('a');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const old = await connectRaw(pa, { deviceId: 'old', vaultId: (A.coord as any).vaultId, nonce: undefined });
    expect(old.isClosed()).toBe(true);
    expect(count(A, 'Refused')).toBe(1);
    expect(A.events.some((e) => e.includes('plugin version is older'))).toBe(true);
  });

  it('accepts the same key typed with other case and spacing', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'n.md': 'hello' });
    const pa = ports();
    track(await startNode(ra, 'aaaa', pa, [], { syncKey: 'ABCD-EFGH' }));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa], { syncKey: 'abcd efgh' }));
    await sleep(1500);
    expect(B.vault.text('n.md')).toBe('hello');
  });

  it('syncs empty notes, both on connect and when created live', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'empty-offline.md': '', 'Folder/empty2.md': '' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(2000);
    expect(B.vault.text('empty-offline.md')).toBe('');
    expect(B.vault.text('Folder/empty2.md')).toBe('');
    await A.vault.write('empty-live.md', '');
    await sleep(800);
    expect(B.vault.text('empty-live.md')).toBe('');
    // Typing into the new empty note afterwards still syncs normally.
    await B.vault.write('empty-live.md', 'now with text');
    await sleep(800);
    expect(A.vault.text('empty-live.md')).toBe('now with text');
  });

  it('reports the peer count again when a peer connects or disconnects', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const counts: number[] = [];
    A.coord.onStateChange(() => counts.push(A.coord.getConnectedDevices().length));
    const B = await startNode(rb, 'bbbb', pa + 1, [pa]);
    await sleep(1500);
    expect(counts.at(-1)).toBe(1);
    await B.coord.stop();
    await sleep(800);
    expect(counts.at(-1)).toBe(0);
  });
});

describe('e2e folders', { timeout: 30000 }, () => {
  let local: Node[] = [];
  afterEach(async () => { for (const n of local) await n.coord.stop(); local = []; });
  const t = (n: Node) => (local.push(n), n);
  const isDir = (n: Node, p: string) => n.vault.getAbstractFileByPath(p) instanceof TFolder;

  it('syncs empty folders and folder renames and deletes without leftovers', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    fs.mkdirSync(path.join(ra, 'Empty/Inner'), { recursive: true });
    seed(ra, { 'Old/a.md': 'a', 'Old/Sub/b.md': 'b', 'Gone/c.md': 'c' });
    const pa = ports();
    const A = t(await startNode(ra, 'aaaa', pa, []));
    const B = t(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(2000);
    expect(isDir(B, 'Empty/Inner')).toBe(true);
    await A.vault.createFolder('Live');
    await A.vault.renameFolder('Old', 'New');
    await A.vault.deleteFolder('Gone');
    await sleep(1500);
    expect(isDir(B, 'Live')).toBe(true);
    expect(B.vault.text('New/Sub/b.md')).toBe('b');
    expect(B.vault.exists('Old')).toBe(false);
    expect(B.vault.exists('Gone')).toBe(false);
  });

  it('removes a folder deleted while apart, and keeps one that got new files', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    fs.mkdirSync(path.join(ra, 'Drop'), { recursive: true });
    fs.mkdirSync(path.join(ra, 'Keep'), { recursive: true });
    const pa = ports();
    let A = t(await startNode(ra, 'aaaa', pa, []));
    let B = t(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(2000);
    expect(isDir(B, 'Drop')).toBe(true);
    await A.coord.stop();
    local = local.filter((n) => n !== A);
    await B.vault.deleteFolder('Drop');
    await B.vault.deleteFolder('Keep');
    await sleep(200);
    seed(ra, { 'Keep/new.md': 'added while apart' });
    A = t(await startNode(ra, 'aaaa', pa, []));
    await sleep(2500);
    expect(A.vault.exists('Drop')).toBe(false);
    expect(B.vault.exists('Drop')).toBe(false);
    expect(B.vault.text('Keep/new.md')).toBe('added while apart');
  });
});

describe('e2e rename while a peer edits', { timeout: 60000 }, () => {
  // Devices run apart (no peers), then reconnect: B and C dial A.
  async function phase(roots: string[], ids: string[], pa: number, connect: boolean) {
    for (const n of nodes) await n.coord.stop();
    nodes = [];
    await sleep(50);
    const out: Node[] = [];
    for (let i = 0; i < roots.length; i++) {
      out.push(track(await startNode(roots[i], ids[i], pa + i, connect && i > 0 ? [pa] : [])));
    }
    return out;
  }
  const notes = (root: string) => {
    const out: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const rel = d ? `${d}/${e.name}` : e.name; if ((rel.startsWith('.obsidian') || rel.startsWith('.lan-vault-sync'))) continue; if (e.isDirectory()) walk(rel); else out.push(rel); } };
    walk(''); return out.sort();
  };

  it('does not delete a note that is renamed while a peer\'s deletion of its old name is applied', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'f.md': 'one\n' });
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const deleting = (B.coord as any).binarySync.applyRemoteDelete('f.md');
    await B.vault.mv('f.md', 'g.md');
    await deleting;
    await sleep(300);
    expect(B.vault.text('g.md')).toBe('one\n');
  });

  it('takes a late file event for an earlier remote write as that write, not as an edit', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'f.md': 'one\n' });
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const dm = (B.coord as any).docManager;
    await (B.coord as any)._ensureCrdtInitialized('f.md');
    const peer = new Y.Doc();
    Y.applyUpdate(peer, await dm.encodeFullState('f.md'));
    const send = async (at: number, text: string) => {
      const before = Y.encodeStateVector(peer);
      peer.getText('content').insert(at, text);
      const msg = decodeMessage(encodeYjsSync(MessageType.YJS_UPDATE, 'f.md', Y.encodeStateAsUpdate(peer, before)));
      await (B.coord as any)._handleMessage('aaaa', msg.type, msg.payload);
    };
    await send(4, 'two\n');
    await send(8, 'three\n');
    // Obsidian reports the first write late, with the text it wrote then.
    await (B.coord as any)._handleLocalFileChange({ type: 'modify', path: 'f.md', content: 'one\ntwo\n', isTextFile: true, timestamp: Date.now() });
    expect(await dm.getContent('f.md')).toBe('one\ntwo\nthree\n');
    // The file is read again shortly after: it holds the newest write, so
    // still nothing is taken as an edit.
    await sleep(2000);
    expect(await dm.getContent('f.md')).toBe('one\ntwo\nthree\n');
    expect(B.vault.text('f.md')).toBe('one\ntwo\nthree\n');
  });

  it('keeps an edit when the peer\'s text for the new name arrives while following a rename', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'f.md': 'one\n' });
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const dm = (B.coord as any).docManager;
    await (B.coord as any)._ensureCrdtInitialized('f.md');
    // The peer moved the note; its text for the new name has arrived.
    Y.applyUpdate(await dm.getOrCreateDoc('sub/g.md'), await dm.encodeFullState('f.md'));
    await B.vault.write('f.md', 'one\nfrom B\n');
    await (B.coord as any)._flushPendingLocalTextChange('f.md');
    await dm.applyLocalChange('f.md', 'one\nfrom B\n');
    // ...and is written while the note is being moved.
    const record = (B.coord as any)._recordRename.bind(B.coord);
    (B.coord as any)._recordRename = async (a: string, b: string) => {
      await (B.coord as any)._writeFileFromRemote('sub/g.md', 'one\n', '');
      return record(a, b);
    };
    expect(await (B.coord as any)._followRemoteRename('aaaa', 'f.md', 'sub/g.md')).toBe(true);
    await sleep(600);
    expect(B.vault.exists('f.md')).toBe(false);
    expect(B.vault.text('sub/g.md')).toBe('one\nfrom B\n');
    expect(await dm.getContent('sub/g.md')).toBe('one\nfrom B\n');
  });

  it('keeps edits merged into a note while a peer\'s deletion of its old copy is applied', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'f.md': 'one\n', 'g.md': 'one\n' });
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const dm = (B.coord as any).docManager;
    await (B.coord as any)._ensureCrdtInitialized('f.md');
    // A peer renamed the note to g.md; we have its copy and our edited f.md.
    Y.applyUpdate(await dm.getOrCreateDoc('g.md'), await dm.encodeFullState('f.md'));
    await B.vault.write('f.md', 'one\nfrom B\n');
    await (B.coord as any)._flushPendingLocalTextChange('f.md');
    await dm.applyLocalChange('f.md', 'one\nfrom B\n');
    // Another peer moved the note on and removes the unedited copy of g.md;
    // keeping its old version takes a while.
    const store = (B.coord as any).versionStore;
    const keep = store.keep.bind(store);
    store.keep = async (...a: unknown[]) => { await sleep(300); return keep(...a); };
    const hash = await computeFileHash(new TextEncoder().encode('one\n').buffer);
    const del = decodeMessage(encodeFileDelete({ path: 'g.md', hash }));
    const deleting = (B.coord as any)._handleMessage('cccc', del.type, del.payload);
    await sleep(50);
    expect(await (B.coord as any)._followRemoteRename('aaaa', 'f.md', 'g.md')).toBe(true);
    await deleting;
    await sleep(500);
    expect(B.vault.exists('g.md') ? B.vault.text('g.md') : await dm.getContent('g.md')).toBe('one\nfrom B\n');
    expect(notes(rb).map((p) => B.vault.text(p)).join('')).toContain('from B');
  });

  it('answers a sync request for a renamed note\'s old name without an error', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'f.md': 'one\n' });
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    await (B.coord as any)._ensureCrdtInitialized('f.md');
    await B.vault.mv('f.md', 'g.md');
    await sleep(300);
    const msg = decodeMessage(encodeYjsSync(MessageType.YJS_SYNC_STEP1, 'f.md', Y.encodeStateVector(new Y.Doc())));
    await expect((B.coord as any)._handleMessage('aaaa', msg.type, msg.payload)).resolves.toBeUndefined();
    expect(B.vault.text('g.md')).toBe('one\n');
  });

  it('keeps an edit when a peer\'s text for the new name arrives while the note is renamed', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'f.md': 'one\n' });
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const dm = (B.coord as any).docManager;
    await (B.coord as any)._ensureCrdtInitialized('f.md');
    const peer = new Y.Doc();
    Y.applyUpdate(peer, await dm.encodeFullState('f.md'));
    peer.getText('content').insert(0, 'from A\n');
    await B.vault.write('f.md', 'one\nfrom B\n');
    await (B.coord as any)._flushPendingLocalTextChange('f.md');
    await dm.applyLocalChange('f.md', 'one\nfrom B\n');
    // Another peer's text for the new name comes in just after the file
    // took the new name.
    const record = (B.coord as any)._recordRename.bind(B.coord);
    let receiving: Promise<void> | undefined;
    (B.coord as any)._recordRename = async (a: string, b: string) => {
      const msg = decodeMessage(encodeYjsSync(MessageType.YJS_SYNC_STEP2, 'g.md', Y.encodeStateAsUpdate(peer)));
      receiving = (B.coord as any)._handleMessage('cccc', msg.type, msg.payload);
      await sleep(200);
      return record(a, b);
    };
    expect(await (B.coord as any)._followRemoteRename('aaaa', 'f.md', 'g.md')).toBe(true);
    await receiving;
    await sleep(600);
    expect(B.vault.text('g.md')).toBe('from A\none\nfrom B\n');
    expect(await dm.getContent('g.md')).toBe('from A\none\nfrom B\n');
  });

  it('keeps a note\'s text when its doc is evicted before the text is written', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'f.md': 'one\n' });
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const dm = (B.coord as any).docManager;
    await (B.coord as any)._ensureCrdtInitialized('f.md');
    // A peer's change is in the doc; the file is not written yet.
    const doc = await dm.getOrCreateDoc('f.md');
    doc.getText('content').insert(4, 'two\n');
    // Many other notes are opened, so the doc is saved and dropped.
    for (let k = 0; k < 60; k++) await dm.getOrCreateDoc(`other${k}.md`);
    await sleep(500);
    expect(dm.pool.has('f.md')).toBe(false);
    await (B.coord as any)._ensureCrdtInitialized('f.md');
    expect(await dm.getContent('f.md')).toBe('one\ntwo\n');
  });

  it('writes the latest text when two peers\' text for a new note is written at once', async () => {
    const rb = tmpRoot('b');
    seed(rb, {});
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const dm = (B.coord as any).docManager;
    const doc = await dm.getOrCreateDoc('n.md');
    doc.getText('content').insert(0, 'one\n');
    // Creating the file takes a while.
    const create = B.vault.create.bind(B.vault);
    (B.vault as any).create = async (p: string, c: string) => { await sleep(200); return create(p, c); };
    const first = (B.coord as any)._writeFileFromRemote('n.md', 'one\n', '');
    await sleep(50);
    doc.getText('content').insert(4, 'two\n');
    const second = (B.coord as any)._writeFileFromRemote('n.md', 'one\ntwo\n', 'one\n');
    await Promise.all([first, second]);
    expect(B.vault.text('n.md')).toBe('one\ntwo\n');
  });

  it('does not save a doc again when it is evicted unchanged', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'f.md': 'one\n' });
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const dm = (B.coord as any).docManager;
    const evictAll = async (from: number) => { for (let k = from; k < from + 60; k++) await dm.getOrCreateDoc(`other${k}.md`); await sleep(300); };
    await (B.coord as any)._ensureCrdtInitialized('f.md');
    await evictAll(0);
    const saved: string[] = [];
    const save = dm.persistence.saveDoc.bind(dm.persistence);
    dm.persistence.saveDoc = async (p: string, d: unknown) => { saved.push(p); return save(p, d); };
    await dm.getOrCreateDoc('f.md');
    await evictAll(100);
    expect(saved).not.toContain('f.md');
    (await dm.getOrCreateDoc('f.md')).getText('content').insert(4, 'two\n');
    await evictAll(200);
    expect(saved).toContain('f.md');
    expect(await dm.getContent('f.md')).toBe('one\ntwo\n');
  });

  it('moves a note to a name that was deleted here and then came back from a peer', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'f.md': 'one\n' });
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const dm = (B.coord as any).docManager;
    await (B.coord as any)._ensureCrdtInitialized('f.md');
    // g.md was deleted here, then a peer's edited copy of it came back.
    (B.coord as any).tombstones.add('g.md', 'aaaa');
    Y.applyUpdate(await dm.getOrCreateDoc('g.md'), await dm.encodeFullState('f.md'));
    await (B.coord as any)._writeFileFromRemote('g.md', 'one\n', undefined);
    expect((B.coord as any).tombstones.get('g.md')).toBeUndefined();
    // So the peer's move of f.md to g.md is followed.
    expect(await (B.coord as any)._followRemoteRename('aaaa', 'f.md', 'g.md')).toBe(true);
    await sleep(300);
    expect(B.vault.exists('f.md')).toBe(false);
    expect(B.vault.text('g.md')).toBe('one\n');
  });

  it('keeps the renamed note when two peers lead to following the same rename at once', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'f.md': 'one\nfrom B\n' });
    const B = track(await startNode(rb, 'bbbb', ports(), []));
    const dm = (B.coord as any).docManager;
    await (B.coord as any)._ensureCrdtInitialized('f.md');
    // The peer's text for the new name has been received but not written yet.
    Y.applyUpdate(await dm.getOrCreateDoc('sub/g.md'), await dm.encodeFullState('f.md'));
    // Recording the rename takes a while (it hashes the file), so the other
    // call gets ahead of it.
    const record = (B.coord as any)._recordRename.bind(B.coord);
    (B.coord as any)._recordRename = async (a: string, b: string) => { await sleep(300); return record(a, b); };
    const follow = () => (B.coord as any)._followRemoteRename('aaaa', 'f.md', 'sub/g.md');
    await Promise.all([follow(), follow()]);
    await sleep(500);
    expect(B.vault.exists('f.md')).toBe(false);
    expect(B.vault.text('sub/g.md')).toBe('one\nfrom B\n');
    expect((B.coord as any).tombstones.get('sub/g.md')).toBeUndefined();
  });

  it('does not pass an old-name edit around forever between three devices', async () => {
    const ids = ['aaaa', 'bbbb', 'cccc'];
    const roots = ids.map((id) => tmpRoot(id));
    const pa = ports();
    const mesh = async (connect: boolean) => {
      for (const x of nodes) await x.coord.stop();
      nodes = [];
      await sleep(50);
      const out: Node[] = [];
      for (let i = 0; i < 3; i++) out.push(track(await startNode(roots[i], ids[i], pa + i, connect ? [pa, pa + 1, pa + 2].slice(0, i) : [])));
      return out;
    };
    seed(roots[0], { 'f.md': 'one\n' });
    let n = await mesh(true);
    await sleep(2500);
    // An edit made under the old name, from a device that has not seen the rename.
    const old = new Y.Doc();
    Y.applyUpdate(old, await (n[1].coord as any).docManager.encodeFullState('f.md'));
    const before = Y.encodeStateVector(old);
    old.getText('content').insert(0, 'late ');
    n = await mesh(false);
    await n[0].vault.mv('f.md', 'g.md');
    n = await mesh(true);
    await sleep(6000);
    for (const data of [Y.encodeStateAsUpdate(old, before), Y.encodeStateAsUpdate(old)]) {
      const msg = decodeMessage(encodeYjsSync(MessageType.YJS_UPDATE, 'f.md', data));
      await (n[0].coord as any)._handleMessage('dddd', msg.type, msg.payload);
    }
    await sleep(4000);
    const merges = n.map((x) => x.events.filter((e) => e.startsWith('Merged edits')).length);
    expect(Math.max(...merges)).toBeLessThan(5);
    for (const x of n) {
      expect(x.vault.exists('f.md')).toBe(false);
      expect(x.vault.text('g.md')).toBe('late one\n');
    }
  });

  it('keeps edits to notes another device moved, with five devices', async () => {
    const ids = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'];
    const roots = ids.map((id) => tmpRoot(id));
    const pa = ports();
    const base: Record<string, string> = {};
    for (let k = 0; k < 10; k++) base[`y${k}.md`] = `head y${k}\nmid\ntail\n`;
    seed(roots[0], base);
    let n = await phase(roots, ids, pa, true);
    await sleep(4000);
    n = await phase(roots, ids, pa, false);
    for (let k = 0; k < 10; k++) {
      await n[2].vault.write(`y${k}.md`, `head y${k}\nmid\ntail\n[C${k}]\n`);
      await n[3].vault.mv(`y${k}.md`, `sub/y${k}.md`);
    }
    await sleep(500);
    for (const x of nodes) await x.coord.stop();
    nodes = [];
    await sleep(50);
    // Every device dials every other, as discovery does on a LAN.
    n = [];
    for (let i = 0; i < 5; i++) n.push(track(await startNode(roots[i], ids[i], pa + i, ids.map((_, j) => pa + j).filter((_, j) => j < i))));
    await sleep(15000);
    for (let i = 0; i < 5; i++) {
      expect(notes(roots[i]).filter((p) => p.endsWith('.md')).length, `device ${ids[i]}`).toBe(10);
      for (let k = 0; k < 10; k++) expect(n[i].vault.text(`sub/y${k}.md`), `device ${ids[i]} y${k}`).toContain(`[C${k}]`);
    }
  });

  it('keeps one copy when a note is moved, deleted, renamed and edited on four devices', async () => {
    const ids = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'];
    const roots = ids.map((id) => tmpRoot(id));
    const pa = ports();
    const base: Record<string, string> = {};
    for (let k = 0; k < 6; k++) base[`q${k}.md`] = `head q${k}\nmid\ntail\n`;
    seed(roots[0], base);
    let n = await phase(roots, ids, pa, true);
    await sleep(4000);
    n = await phase(roots, ids, pa, false);
    for (let k = 0; k < 6; k++) await n[0].vault.mv(`q${k}.md`, `sub/q${k}.md`);
    await sleep(30);
    for (let k = 0; k < 6; k++) await n[1].vault.rm(`q${k}.md`);
    await sleep(30);
    for (let k = 0; k < 6; k++) await n[3].vault.mv(`q${k}.md`, `q${k}-r4.md`);
    await sleep(30);
    for (let k = 0; k < 6; k++) await n[4].vault.write(`q${k}.md`, `head q${k}\nmid\ntail\n[E${k}]\n`);
    await sleep(500);
    for (const x of nodes) await x.coord.stop();
    nodes = [];
    await sleep(50);
    n = [];
    for (let i = 0; i < 5; i++) n.push(track(await startNode(roots[i], ids[i], pa + i, ids.map((_, j) => pa + j).filter((_, j) => j < i))));
    await sleep(15000);
    for (let i = 0; i < 5; i++) {
      // The last rename wins; the edit keeps the note.
      expect(`${ids[i]}: ${notes(roots[i]).join(" ")}`).toEqual(`${ids[i]}: ` + [...Array(6)].map((_, k) => `q${k}-r4.md`).sort().join(" "));
      for (let k = 0; k < 6; k++) expect(n[i].vault.text(`q${k}-r4.md`), `device ${ids[i]} q${k}`).toContain(`[E${k}]`);
    }
  });

  it('moves an offline edit to the name a peer gave the note', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports(), ids = ['aaaa', 'bbbb'];
    seed(ra, { 'f.md': 'one\ntwo\nthree\n' });
    let [A, B] = await phase([ra, rb], ids, pa, true);
    await sleep(2000);
    expect(B.vault.text('f.md')).toBe('one\ntwo\nthree\n');
    [A, B] = await phase([ra, rb], ids, pa, false);
    await A.vault.mv('f.md', 'dir/g.md');
    await A.vault.write('dir/g.md', 'one\ntwo\nthree\nfrom A\n');
    await B.vault.write('f.md', 'from B\none\ntwo\nthree\n');
    await sleep(800);
    [A, B] = await phase([ra, rb], ids, pa, true);
    await sleep(4000);
    for (const [r, n] of [[ra, A], [rb, B]] as const) {
      expect(notes(r)).toEqual(['dir/g.md']);
      expect(n.vault.text('dir/g.md')).toBe('from B\none\ntwo\nthree\nfrom A\n');
    }
  });

  it('keeps one copy when two devices renamed the same file to different names', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports(), ids = ['aaaa', 'bbbb'];
    seed(ra, { 'r.md': 'r\n', 'p.png': Buffer.from([1, 2, 3]) });
    let [A, B] = await phase([ra, rb], ids, pa, true);
    await sleep(2000);
    expect(B.vault.text('r.md')).toBe('r\n');
    [A, B] = await phase([ra, rb], ids, pa, false);
    await A.vault.mv('r.md', 'r-a.md');
    await A.vault.mv('p.png', 'p-a.png');
    await sleep(20);
    // B renames later, so its names win.
    await B.vault.mv('r.md', 'r-b.md');
    await B.vault.write('r-b.md', 'r\nedited on B\n');
    await B.vault.mv('p.png', 'p-b.png');
    await sleep(800);
    [A, B] = await phase([ra, rb], ids, pa, true);
    await sleep(4000);
    for (const [r, n] of [[ra, A], [rb, B]] as const) {
      expect(notes(r)).toEqual(['p-b.png', 'r-b.md']);
      expect(n.vault.text('r-b.md')).toBe('r\nedited on B\n');
    }
  });

  it('keeps one copy when one of two renames of a file was made while sync was off', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports(), ids = ['aaaa', 'bbbb'];
    seed(ra, { 'r.md': 'r\n', 'p.png': Buffer.from([1, 2, 3]) });
    let [A, B] = await phase([ra, rb], ids, pa, true);
    await until(() => B.vault.text('r.md') === 'r\n' && B.vault.exists('p.png'));
    await sleep(300);
    [A, B] = await phase([ra, rb], ids, pa, false);
    await B.vault.mv('r.md', 'r-b.md');
    await B.vault.write('r-b.md', 'r\nedited on B\n');
    await B.vault.mv('p.png', 'p-b.png');
    await sleep(300);
    // A's sync is off; its files are renamed meanwhile, later than B's.
    await A.coord.stop();
    nodes = nodes.filter((n) => n !== A);
    fs.renameSync(path.join(ra, 'r.md'), path.join(ra, 'r-a.md'));
    fs.renameSync(path.join(ra, 'p.png'), path.join(ra, 'p-a.png'));
    await sleep(50);
    [A, B] = await phase([ra, rb], ids, pa, true);
    await until(() => notes(rb).join() === 'p-a.png,r-a.md' && B.vault.text('r-a.md') === 'r\nedited on B\n', 10000);
    await sleep(500);
    for (const [r, n] of [[ra, A], [rb, B]] as const) {
      expect(notes(r)).toEqual(['p-a.png', 'r-a.md']);
      expect(n.vault.text('r-a.md')).toBe('r\nedited on B\n');
    }
  });

  it('settles two devices renaming or deleting the same files at once without waiting for a periodic sync', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports(), ids = ['aaaa', 'bbbb'];
    seed(ra, { 'r.md': 'r\n', 'p.png': Buffer.from([1]), 'd.md': 'd\n', 'q.png': Buffer.from([2]) });
    let [A, B] = await phase([ra, rb], ids, pa, true);
    await until(() => notes(rb).length === 4);
    await sleep(300);
    // Each acts before the other's change arrives (no periodic sync here).
    await Promise.all([
      (async () => { await A.vault.mv('r.md', 'r-a.md'); await A.vault.mv('p.png', 'p-a.png'); await A.vault.mv('d.md', 'd-a.md'); await A.vault.mv('q.png', 'q-a.png'); })(),
      (async () => { await B.vault.mv('r.md', 'r-b.md'); await B.vault.mv('p.png', 'p-b.png'); await B.vault.rm('d.md'); await B.vault.rm('q.png'); })(),
    ]);
    // One name per file, the same on both; the later of a rename and a
    // deletion wins (the two may fall in the same millisecond here).
    const settled = () => {
      const [a, b] = [notes(ra), notes(rb)];
      return a.join() === b.join() && ['r', 'p'].every((c) => a.filter((p) => p[0] === c).length === 1) &&
        ['d', 'q'].every((c) => a.filter((p) => p[0] === c).length <= 1) && !a.some((p) => /^[rpdq]\./.test(p));
    };
    await until(settled, 8000);
    await sleep(1000);
    expect(notes(ra)).toEqual(notes(rb));
    expect(settled()).toBe(true);
  });

  it('keeps one copy when three devices renamed the same note to different names', async () => {
    const ids = ['aaaa', 'bbbb', 'cccc'];
    const roots = ids.map((id) => tmpRoot(id));
    const pa = ports();
    seed(roots[0], { 'r.md': 'r\n' });
    let n = await phase(roots, ids, pa, true);
    await sleep(2500);
    n = await phase(roots, ids, pa, false);
    for (const [i, x] of n.entries()) { await x.vault.mv('r.md', `r-${ids[i][0]}.md`); await sleep(20); }
    await sleep(800);
    n = await phase(roots, ids, pa, true);
    await sleep(6000);
    for (const r of roots) expect(notes(r)).toEqual(['r-c.md']);
  });

  it('keeps one copy when a later rename meets a device whose earlier rename a peer followed', async () => {
    const ids = ['aaaa', 'bbbb', 'cccc'];
    const roots = ids.map((id) => tmpRoot(id));
    const pa = ports();
    seed(roots[0], { 'r.md': 'r\none\n' });
    let n = await phase(roots, ids, pa, true);
    await sleep(2500);
    n = await phase(roots, ids, pa, false);
    await n[0].vault.mv('r.md', 'r-a.md');
    await sleep(20);
    // B renames later, so its name wins.
    await n[1].vault.mv('r.md', 'r-b.md');
    await n[2].vault.write('r.md', 'r\none\nfrom C\n');
    await sleep(800);
    for (const x of nodes) await x.coord.stop();
    nodes = [];
    await sleep(50);
    // C meets A first and moves its edit to A's name...
    const A = track(await startNode(roots[0], ids[0], pa, []));
    const before = (A.coord as any).tombstones.get('r.md');
    track(await startNode(roots[2], ids[2], pa + 2, [pa]));
    await sleep(3000);
    // A's record of its own rename stays as it was.
    expect((A.coord as any).tombstones.get('r.md')).toEqual(before);
    // ...then B joins both.
    const B = track(await startNode(roots[1], ids[1], pa + 1, [pa, pa + 2]));
    await sleep(6000);
    for (const r of roots) expect(notes(r)).toEqual(['r-b.md']);
    expect(B.vault.text('r-b.md')).toContain('from C');
  });

  it('keeps one copy when both names of a note renamed twice reached every device first', async () => {
    const ids = ['aaaa', 'bbbb', 'cccc'];
    const roots = ids.map((id) => tmpRoot(id));
    const pa = ports();
    seed(roots[0], { 'r.md': 'r\none\n' });
    let n = await phase(roots, ids, pa, true);
    await sleep(2500);
    n = await phase(roots, ids, pa, false);
    await n[0].vault.mv('r.md', 'r-a.md');
    await sleep(20);
    // B renames later, so its name wins.
    await n[1].vault.mv('r.md', 'r-b.md');
    await n[2].vault.write('r.md', 'r\none\nfrom C\n');
    await sleep(800);
    for (const x of nodes) await x.coord.stop();
    nodes = [];
    await sleep(50);
    // C meets A, then B, so it hands each one the other's name...
    const A = track(await startNode(roots[0], ids[0], pa, []));
    const C = track(await startNode(roots[2], ids[2], pa + 2, [pa]));
    await sleep(3000);
    await C.coord.stop();
    nodes = nodes.filter((x) => x !== C);
    const B = track(await startNode(roots[1], ids[1], pa + 1, []));
    track(await startNode(roots[2], ids[2], pa + 2, [pa + 1]));
    await sleep(3000);
    // ...and only then do A and B meet.
    await A.coord.stop();
    nodes = nodes.filter((x) => x !== A);
    track(await startNode(roots[0], ids[0], pa, [pa + 1, pa + 2]));
    await sleep(6000);
    for (const r of roots) expect(notes(r)).toEqual(['r-b.md']);
    expect(B.vault.text('r-b.md')).toContain('from C');
  });

  it('keeps a note deleted after a peer moved it deleted', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports(), ids = ['aaaa', 'bbbb'];
    seed(ra, { 'dir/x.md': 'x\n', 'dir/y.md': 'y\n', 'dir/z.png': Buffer.from([1, 2, 3]) });
    let [A, B] = await phase([ra, rb], ids, pa, true);
    await sleep(2000);
    [A, B] = await phase([ra, rb], ids, pa, false);
    // A renames the folder, which moves each file in it.
    for (const f of ['x.md', 'y.md', 'z.png']) await A.vault.mv(`dir/${f}`, `dir2/${f}`);
    await sleep(20);
    // B deletes two of the files afterwards.
    await B.vault.rm('dir/y.md');
    await B.vault.rm('dir/z.png');
    await sleep(800);
    [A, B] = await phase([ra, rb], ids, pa, true);
    await sleep(4000);
    expect([notes(ra), notes(rb)]).toEqual([['dir2/x.md'], ['dir2/x.md']]);
  });

  it('keeps a note renamed after a deletion that a third device passed on', async () => {
    const ids = ['aaaa', 'bbbb', 'cccc'];
    const [ra, rb, rc] = ids.map((id) => tmpRoot(id));
    const pa = ports();
    seed(ra, { 'f.md': 'f\n' });
    let n = await phase([ra, rb, rc], ids, pa, true);
    await sleep(2500);
    n = await phase([ra, rb, rc], ids, pa, false);
    await n[0].vault.rm('f.md');
    await sleep(50);
    // B renames the note after A deleted it, so the rename wins.
    await n[1].vault.mv('f.md', 'g.md');
    await sleep(500);
    // C learns of the deletion first...
    n = await phase([ra, rc], ['aaaa', 'cccc'], pa, true);
    await sleep(2500);
    expect(notes(rc)).toEqual([]);
    // ...and then meets B.
    n = await phase([rb, rc], ['bbbb', 'cccc'], pa, true);
    await sleep(3000);
    expect([notes(rb), notes(rc)]).toEqual([['g.md'], ['g.md']]);
  });

  it('keeps the latest name when two devices gave a note the same name around another rename', async () => {
    const ids = ['aaaa', 'bbbb', 'cccc'];
    const [ra, rb, rc] = ids.map((id) => tmpRoot(id));
    const pa = ports();
    seed(ra, { 'f.md': 'f\n' });
    let n = await phase([ra, rb, rc], ids, pa, true);
    await sleep(2500);
    n = await phase([ra, rb, rc], ids, pa, false);
    await n[0].vault.mv('f.md', 'sub/f.md');
    await sleep(30);
    await n[1].vault.mv('f.md', 'g.md');
    await sleep(30);
    // C gives it the same name as A, last.
    await n[2].vault.mv('f.md', 'sub/f.md');
    await sleep(500);
    // A meets C first: both have the same name, nothing to do...
    n = await phase([ra, rc], ['aaaa', 'cccc'], pa, true);
    await sleep(2000);
    // ...then B, whose rename came before C's.
    n = await phase([ra, rb], ['aaaa', 'bbbb'], pa, true);
    await sleep(3000);
    expect([notes(ra), notes(rb)]).toEqual([['sub/f.md'], ['sub/f.md']]);
  });

  it('does not double a note that two peers created on their own at the same time', async () => {
    const C = track(await startNode(tmpRoot('c'), 'cccc', ports(), []));
    const history = (text: string) => {
      const d = new Y.Doc();
      d.getText('content').insert(0, text);
      return decodeMessage(encodeYjsSync(MessageType.YJS_UPDATE, 'n (conflict 1a2b3c).md', Y.encodeStateAsUpdate(d)));
    };
    const a = history('same text\n'), b = history('same text\n');
    await Promise.all([
      (C.coord as any)._handleMessage('aaaa', a.type, a.payload),
      (C.coord as any)._handleMessage('bbbb', b.type, b.payload),
    ]);
    await sleep(500);
    expect(C.vault.text('n (conflict 1a2b3c).md')).toBe('same text\n');
  });

  it('merges edits a peer sends under the old name into the renamed note', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports(), ids = ['aaaa', 'bbbb'];
    seed(ra, { 'f.md': 'one\ntwo\n' });
    let [A, B] = await phase([ra, rb], ids, pa, true);
    await sleep(2000);
    [A, B] = await phase([ra, rb], ids, pa, false);
    await A.vault.mv('f.md', 'g.md');
    await B.vault.write('f.md', 'one\ntwo\nfrom B\n');
    await sleep(800);
    // B's copy reaches A under the old name, e.g. relayed by a third device.
    const state = await (B.coord as any).docManager.encodeFullState('f.md');
    const msg = decodeMessage(encodeYjsSync(MessageType.YJS_FULL_STATE, 'f.md', state));
    await (A.coord as any)._handleMessage('cccc', msg.type, msg.payload);
    await sleep(500);
    expect(A.vault.exists('f.md')).toBe(false);
    expect(A.vault.text('g.md')).toBe('one\ntwo\nfrom B\n');
  });

  it('moves offline edits from two devices to the new name, with three devices', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    const pa = ports(), ids = ['aaaa', 'bbbb', 'cccc'];
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`n${i}.md`] = `note ${i}\n`;
    seed(ra, { ...files, 'f.md': 'one\ntwo\n', 'h.md': 'keep\n' });
    let all = await phase([ra, rb, rc], ids, pa, true);
    await sleep(5000);
    for (const n of all) expect(n.vault.text('f.md')).toBe('one\ntwo\n');
    all = await phase([ra, rb, rc], ids, pa, false);
    await all[0].vault.mv('f.md', 'g.md');
    await all[1].vault.write('f.md', 'one\ntwo\nfrom B\n');
    await all[2].vault.write('f.md', 'from C\none\ntwo\n');
    await all[2].vault.write('n5.md', 'note 5\nfrom C\n');
    await sleep(800);
    all = await phase([ra, rb, rc], ids, pa, true);
    await sleep(8000);
    const expected = notes(ra);
    expect(expected).not.toContain('f.md');
    for (const [i, n] of all.entries()) {
      expect(notes([ra, rb, rc][i])).toEqual(expected);
      expect(n.vault.text('g.md')).toBe('from C\none\ntwo\nfrom B\n');
      expect(n.vault.text('n5.md')).toBe('note 5\nfrom C\n');
    }
  });
});
