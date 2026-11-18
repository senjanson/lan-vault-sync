/**
 * Large files (plan 6.4), between real nodes: a 20 MB file is sent in
 * chunks paced by what the socket still has to send, received into a
 * temporary file, checked against the sender's hash, and refused when it is
 * over the receiving device's limit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/discovery/udp-broadcast', () => ({
  UdpBroadcast: class {
    onDeviceSeen() {}
    async start() {}
    stop() {}
  },
}));

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { connectRaw, Node, ports, sleep, startNode, tmpRoot, until } from './harness';
import { encodeFileChunk } from '../../src/transport/protocol';
import { computeFileHash } from '../../src/binary-sync/file-hash';
import { CHUNK_SIZE, INCOMING_DIR } from '../../src/constants';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

const MB = 1024 * 1024;

/** Gives the test vault's adapter appendBinary, as Obsidian's desktop adapter has; counts the calls. */
function withAppend(n: Node): { appends: number } {
  const stats = { appends: 0 };
  n.vault.adapter.appendBinary = async (p: string, d: ArrayBuffer) => {
    stats.appends++;
    fs.appendFileSync(path.join(n.vault.root, p), Buffer.from(d));
  };
  return stats;
}

function incomingLeft(n: Node): string[] {
  const dir = path.join(n.vault.root, INCOMING_DIR);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/**
 * The most bytes a node had waiting to go to peers at any moment: given to
 * the connection but not yet to the socket (encryption is asynchronous),
 * plus what the socket itself still buffers.
 */
function watchQueued(n: Node): { max: number } {
  const cm = (n.coord as any).connectionManager;
  const stats = { max: 0 };
  let pending = 0;
  const orig = cm._send.bind(cm);
  cm._send = (peer: any, data: Uint8Array) => {
    if (!peer.ws.__watched) {
      peer.ws.__watched = true;
      const send = peer.ws.send.bind(peer.ws);
      peer.ws.send = (frame: Uint8Array) => {
        pending -= frame.byteLength - 24; // counter and tag added by encryption
        send(frame);
        stats.max = Math.max(stats.max, pending + (peer.ws.bufferedAmount ?? 0));
      };
    }
    pending += data.byteLength;
    stats.max = Math.max(stats.max, pending + (peer.ws.bufferedAmount ?? 0));
    orig(peer, data);
  };
  return stats;
}

const connected = (a: Node, b: Node) => () =>
  a.coord.getConnectedDevices().includes(b.settings.deviceId) && b.coord.getConnectedDevices().includes(a.settings.deviceId);

describe('large files', { timeout: 60000 }, () => {
  it('syncs a 20 MB file intact without queueing it all at once', async () => {
    const pa = ports();
    const A = track(await startNode(tmpRoot('a'), 'aaaa', pa, []));
    const B = track(await startNode(tmpRoot('b'), 'bbbb', pa + 1, [pa]));
    await until(connected(A, B));
    const appended = withAppend(B);
    const queued = watchQueued(A);
    const content = crypto.randomBytes(20 * MB);
    await A.vault.writeBin('big.bin', content);
    await until(() => B.vault.bin('big.bin')?.equals(content) ?? false, 40000);
    expect(B.vault.bin('big.bin')?.equals(content)).toBe(true);
    expect(appended.appends).toBeGreaterThan(0);
    expect(incomingLeft(B)).toEqual([]);
    // Pacing holds the backlog near 4 MB (plus a chunk); before, all 20 MB was queued.
    expect(queued.max).toBeLessThan(7 * MB);
  });

  it('refuses a file over the receive limit and leaves the existing one', async () => {
    const pa = ports();
    const A = track(await startNode(tmpRoot('a'), 'aaaa', pa, []));
    const B = track(await startNode(tmpRoot('b'), 'bbbb', pa + 1, [pa], { maxReceiveMB: 5, syncIntervalMs: 500 }));
    await until(connected(A, B));
    withAppend(B);
    const small = Buffer.from([1, 2, 3, 4]);
    await A.vault.writeBin('v.bin', small);
    await until(() => B.vault.bin('v.bin')?.equals(small) ?? false);
    expect(B.vault.bin('v.bin')?.equals(small)).toBe(true);

    await A.vault.writeBin('v.bin', crypto.randomBytes(20 * MB));
    const refused = () => B.coord.eventLog.recentRecords().find((r) => r.rule === 'too-large' && r.path === 'v.bin');
    await until(() => !!refused(), 20000);
    expect(refused()).toMatchObject({ op: 'skip', level: 'warn', path: 'v.bin', rule: 'too-large' });
    expect((B.coord as any).health.alerts().some((a: { kind: string; path?: string }) => a.kind === 'too-large' && a.path === 'v.bin')).toBe(true);
    await sleep(500);
    expect(B.vault.bin('v.bin')?.equals(small)).toBe(true);
    expect(incomingLeft(B)).toEqual([]);
  });

  it('does not ask for a listed file over the receive limit, so it is not sent', async () => {
    const pa = ports();
    const ra = tmpRoot('a');
    fs.writeFileSync(path.join(ra, 'big.bin'), crypto.randomBytes(9 * MB));
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let paced = 0;
    const cm = (A.coord as any).connectionManager;
    const orig = cm.sendToPaced.bind(cm);
    cm.sendToPaced = (...args: any[]) => { paced++; return orig(...args); };
    const rb = tmpRoot('b');
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa], { maxReceiveMB: 5 }));
    await until(connected(A, B));
    const refused = () => B.coord.eventLog.recentRecords().find((r) => r.rule === 'too-large' && r.path === 'big.bin');
    await until(() => !!refused(), 15000);
    await sleep(1500);
    // Asked for, the file would have been sent in chunks, and thrown away.
    expect(paced).toBe(0);
    expect(B.vault.bin('big.bin')).toBeFalsy();
  });

  it('does not write a file whose chunks do not match the sender\'s hash', async () => {
    const pa = ports();
    const A = track(await startNode(tmpRoot('a'), 'aaaa', pa, []));
    withAppend(A);
    const peer = await connectRaw(pa, { deviceId: 'peer', vaultId: (A.coord as any).vaultId }, 'TEST-KEY');
    await until(() => A.coord.getConnectedDevices().includes('peer'));
    const content = crypto.randomBytes(9 * MB);
    const hash = await computeFileHash(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer);
    for (let offset = 0; offset < content.byteLength; offset += CHUNK_SIZE) {
      const part = Buffer.from(content.subarray(offset, offset + CHUNK_SIZE));
      if (offset === 3 * CHUNK_SIZE) part.fill(0); // damaged on the way
      peer.send(encodeFileChunk({
        path: 'c.bin', mtime: Date.now(), totalSize: content.byteLength, offset, content: part,
        ...(offset === 0 ? { hash, madeAt: Date.now() } : {}),
      }));
    }
    const discarded = () => A.coord.eventLog.recentRecords().find((r) => r.rule === 'bad-hash' && r.path === 'c.bin');
    await until(() => !!discarded(), 15000);
    expect(discarded()).toBeTruthy();
    expect(A.vault.exists('c.bin')).toBe(false);
    expect(incomingLeft(A)).toEqual([]);
    peer.ws.close();
  });
});
