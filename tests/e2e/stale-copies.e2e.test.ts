/**
 * An attachment changed and then deleted elsewhere, while this device still
 * has the version from before the change: the deletion removes that old
 * copy too, instead of the copy being taken for an edit and sent back.
 * A copy changed here is still kept.
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

const V1 = Buffer.alloc(300, 1);
const V2 = Buffer.alloc(700, 2);
const V3 = Buffer.alloc(500, 3);
const is = (n: Node, v: Buffer) => n.vault.bin('p.png')?.equals(v) === true;
const exchange = (n: Node) => (n.coord as any)._periodicFullSync() as Promise<void>;
/** How many of the iPhone's changes Mac refused, as changes of a version it no longer has. */
const refused = (n: Node) =>
  n.coord.eventLog.recentRecords().filter((r) => r.op === 'precondition-failed' && r.path === 'p.png' && r.peer?.startsWith('iphn')).length;

/**
 * Mac relays for two phones that only connect to it, as on the devices
 * where this was found. Attachment changes are not passed on right away;
 * deletions are.
 */
async function threeDevices() {
  const rm = tmpRoot('mac'), ri = tmpRoot('iphone'), rp = tmpRoot('pixel');
  seed(rm, { 'p.png': V1 });
  const p = ports();
  const mac = track(await startNode(rm, 'mac0', p, []));
  const iphone = track(await startNode(ri, 'iphn', p + 1, [p]));
  const pixel = track(await startNode(rp, 'pxl0', p + 2, [p]));
  await until(() => is(iphone, V1) && is(pixel, V1), 10000);
  // The phones list their files again, as they do every half minute.
  await sleep(500);
  await exchange(iphone);
  await exchange(pixel);
  await sleep(800);
  return { mac, iphone, pixel, ri };
}

describe('e2e old copies of a changed and deleted attachment', { timeout: 60000 }, () => {
  it('a phone with the version from before the change deletes it when the relay passes the deletion on', async () => {
    const { mac, iphone, pixel } = await threeDevices();
    await pixel.vault.writeBin('p.png', V2);
    await until(() => is(mac, V2));
    await sleep(300);
    expect(is(iphone, V1)).toBe(true);
    await pixel.vault.rm('p.png');
    await until(() => !mac.vault.exists('p.png'));
    await until(() => !iphone.vault.exists('p.png'), 5000);
    // Mac and the iPhone list their files a moment later.
    await exchange(iphone);
    await sleep(1500);
    await exchange(pixel);
    await sleep(1500);
    for (const n of [mac, iphone, pixel]) expect(n.vault.exists('p.png')).toBe(false);
    // The iPhone's copy was kept before it was deleted.
    await iphone.coord.versionStore!.flush();
    const kept = await iphone.coord.versionStore!.list({ path: 'p.png' });
    expect(kept.some((e) => e.op === 'remote-file-delete' && e.size === V1.length)).toBe(true);
  });

  it('the same deletion found in the file lists, when the phone was away for it', async () => {
    const { mac, iphone, pixel, ri } = await threeDevices();
    await iphone.coord.stop();
    nodes = nodes.filter((x) => x !== iphone);
    await pixel.vault.writeBin('p.png', V2);
    await until(() => is(mac, V2));
    await pixel.vault.rm('p.png');
    await until(() => !mac.vault.exists('p.png'));
    // Mac meets the Pixel again first: its records of the file go.
    await exchange(pixel);
    await sleep(1000);
    const back = track(await startNode(ri, 'iphn', iphone.settings.port, [mac.settings.port]));
    await until(() => !back.vault.exists('p.png'), 8000);
    await sleep(1500);
    await exchange(pixel);
    await sleep(1000);
    for (const n of [mac, back, pixel]) expect(n.vault.exists('p.png')).toBe(false);
  });

  it('a phone with the version from before the change follows a rename made right after it, without a second copy', async () => {
    const { mac, iphone, pixel } = await threeDevices();
    await pixel.vault.writeBin('p.png', V2);
    await until(() => is(mac, V2));
    await pixel.vault.mv('p.png', 'q.png');
    await until(() => !mac.vault.exists('p.png') && mac.vault.bin('q.png')?.equals(V2) === true);
    await sleep(300);
    await exchange(iphone);
    await until(() => !iphone.vault.exists('p.png') && iphone.vault.bin('q.png')?.equals(V2) === true, 5000);
    await sleep(1000);
    await exchange(iphone);
    await exchange(pixel);
    await sleep(1500);
    for (const n of [mac, iphone, pixel]) {
      expect(n.vault.exists('p.png')).toBe(false);
      expect(n.vault.bin('q.png')?.equals(V2)).toBe(true);
      expect(fs.readdirSync(n.vault.root).filter((f) => f.includes('(conflict '))).toEqual([]);
    }
  });

  it('two devices: changed and then deleted on one while the other was off', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'p.png': V1 });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => is(B, V1));
    await sleep(500);
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);
    await A.vault.writeBin('p.png', V2);
    await sleep(200);
    await A.vault.rm('p.png');
    await sleep(300);
    const B2 = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => !B2.vault.exists('p.png'), 8000);
    await sleep(1500);
    expect(B2.vault.exists('p.png')).toBe(false);
    expect(A.vault.exists('p.png')).toBe(false);
  });

  it('keeps a copy changed here while the other device changed and deleted the file, and gives it back', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'p.png': V1 });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => is(B, V1));
    await sleep(500);
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);
    await A.vault.writeBin('p.png', V2);
    await sleep(200);
    await A.vault.rm('p.png');
    // Changed on B while sync was off.
    fs.writeFileSync(path.join(rb, 'p.png'), V3);
    await sleep(300);
    const B2 = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => is(A, V3), 8000);
    await sleep(1000);
    expect(is(B2, V3)).toBe(true);
    expect(is(A, V3)).toBe(true);
  });

  it('keeps a change the relay refused, when the deletion it then passes on is of another version', async () => {
    const { mac, iphone, pixel } = await threeDevices();
    await pixel.vault.writeBin('p.png', V2);
    await until(() => is(mac, V2));
    // The iPhone's change of the version it had: Mac has another by now,
    // and refuses it. The Pixel deletes the file before the two settle it.
    await iphone.vault.writeBin('p.png', V3);
    await until(() => refused(mac) === 1);
    expect(is(mac, V2)).toBe(true);
    await pixel.vault.rm('p.png');
    await until(() => !mac.vault.exists('p.png'));
    await sleep(1000);
    expect(is(iphone, V3)).toBe(true);
    await exchange(iphone);
    await until(() => is(mac, V3), 5000);
    expect(is(mac, V3)).toBe(true);
    expect(is(iphone, V3)).toBe(true);
  });

  it('keeps a copy changed here and back to the version last shared, while the change was not taken', async () => {
    const { mac, iphone, pixel } = await threeDevices();
    await pixel.vault.writeBin('p.png', V2);
    await until(() => is(mac, V2));
    // Changed on the iPhone and back again (say, restored): Mac took
    // neither, so the version both last had is no longer what it means.
    await iphone.vault.writeBin('p.png', V3);
    await until(() => refused(mac) === 1);
    await iphone.vault.writeBin('p.png', V1);
    await until(() => refused(mac) === 2);
    expect(is(mac, V2)).toBe(true);
    await pixel.vault.rm('p.png');
    await until(() => !mac.vault.exists('p.png'));
    await sleep(1000);
    expect(is(iphone, V1)).toBe(true);
    await exchange(iphone);
    await until(() => is(mac, V1), 5000);
    expect(is(mac, V1)).toBe(true);
    expect(is(iphone, V1)).toBe(true);
  });
});

describe('e2e records behind the deletion of old copies', { timeout: 60000 }, () => {
  it('saves the version received from a peer soon, with no file list exchange and no stop', async () => {
    const { AGREED_HASHES_FILE } = await import('../../src/constants');
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'p.png': V1 });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => is(B, V1));
    await sleep(1000);
    // Sent live; files are not listed again (no periodic sync here).
    await A.vault.writeBin('q.png', V3);
    await until(() => B.vault.bin('q.png')?.equals(V3) === true);
    const saved = () => B.vault.text(AGREED_HASHES_FILE) ?? '';
    await until(() => saved().includes('q.png'), 5000);
    // As if the app were killed now: what is on disk is what a restart has.
    expect(saved()).toContain('q.png');
  });

  it('does not ask a peer for old copies of files deleted here while that peer holds their deletion', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const names = Array.from({ length: 12 }, (_, i) => `img${i}.png`);
    seed(ra, Object.fromEntries(names.map((n) => [n, V1])));
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => names.every((n) => B.vault.bin(n)?.equals(V1) === true), 10000);
    await sleep(1000);
    await B.coord.stop();
    nodes = nodes.filter((x) => x !== B);
    // Changed and then deleted on A while B was off.
    for (const n of names) await A.vault.writeBin(n, V2);
    await sleep(300);
    for (const n of names) await A.vault.rm(n);
    await sleep(300);
    const asked: string[] = [];
    const bs = (A.coord as any).binarySync;
    const request = bs.requestFile.bind(bs);
    bs.requestFile = (id: string, p: string, ...rest: unknown[]) => { asked.push(p); return request(id, p, ...rest); };
    const B2 = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    // So many deletions at once wait for the user on B, which keeps the
    // files meanwhile and lists them, as the versions it last had from A.
    await until(() => B2.coord.getHeldDeletions().length > 0, 10000);
    await sleep(1500);
    expect(asked).toEqual([]);
    expect(names.some((n) => A.vault.exists(n))).toBe(false);
    await B2.coord.resolveHeldDeletions(B2.coord.getHeldDeletions()[0].id, 'delete');
    await until(() => names.every((n) => !B2.vault.exists(n)), 8000);
    await exchange(B2);
    await sleep(1000);
    expect(asked).toEqual([]);
    for (const n of names) {
      expect(A.vault.exists(n)).toBe(false);
      expect(B2.vault.exists(n)).toBe(false);
    }
  });
});

/**
 * Three devices that all connect to each other. Two of them got an
 * attachment and went away before they had listed their files to each
 * other; the third changed it and deleted it meanwhile. Each returning
 * device deletes its old copy (it last had that version with the device
 * that deleted it), but neither knew the other's copy was that same old
 * version: one sent its copy to the other, which took it for a file it
 * lacked, and the copy kept being deleted and fetched back, or came back
 * for good.
 */
describe('e2e old copies of a changed and deleted attachment, two devices away', { timeout: 90000 }, () => {
  for (const gap of [0, 1000, 3000]) {
    it(`stays deleted when the two come back ${gap} ms apart`, async () => {
      const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
      const p = ports();
      const A = track(await startNode(ra, 'aaaa', p, [p + 1, p + 2]));
      let B = track(await startNode(rb, 'bbbb', p + 1, [p, p + 2]));
      let C = track(await startNode(rc, 'cccc', p + 2, [p, p + 1]));
      await until(() => [A, B, C].every((n) => n.coord.getConnectedDevices().length === 2), 10000);
      await sleep(1500);
      // Added once all are connected, so B and C only get it sent, and go
      // away before they list their files to each other.
      await A.vault.writeBin('p.png', V1);
      await until(() => is(B, V1) && is(C, V1), 10000);
      await sleep(1000);
      for (const n of [B, C]) {
        await n.coord.stop();
        nodes = nodes.filter((x) => x !== n);
      }
      await A.vault.writeBin('p.png', V2);
      await sleep(1200);
      await A.vault.rm('p.png');
      await sleep(1000);
      B = track(await startNode(rb, 'bbbb', p + 1, [p, p + 2]));
      await sleep(gap);
      C = track(await startNode(rc, 'cccc', p + 2, [p, p + 1]));
      const seen: string[] = [];
      for (let round = 0; round < 6; round++) {
        await sleep(1500);
        for (const n of [A, B, C]) await exchange(n);
        seen.push([A, B, C].map((n) => (n.vault.exists('p.png') ? 'Y' : '-')).join(''));
      }
      expect(seen.slice(-3)).toEqual(['---', '---', '---']);
      // Each returning device kept its old copy once, before deleting it.
      for (const n of [B, C]) {
        await n.coord.versionStore!.flush();
        const kept = (await n.coord.versionStore!.list({ path: 'p.png' })).filter((e) => e.op === 'remote-file-delete');
        expect(kept.length).toBe(1);
      }
    });
  }
});

/**
 * The device that got an attachment was killed a moment after it wrote the
 * file, before it saved its record of the version it now shared (see
 * AgreedVersions, whose writes wait a second or more). The sender records
 * nothing when it sends. The file was then changed and deleted on the
 * sender; when the other device came back, neither knew its copy was the
 * version from before the change, and the sender fetched it back.
 */
describe('e2e old copy kept by a device killed right after it got the file', { timeout: 60000 }, () => {
  for (const made of ['created', 'changed'] as const) {
    it(`stays deleted when the file was ${made} and sent just before the kill`, async () => {
      const { AGREED_HASHES_FILE } = await import('../../src/constants');
      const ra = tmpRoot('a'), rb = tmpRoot('b');
      const V0 = Buffer.alloc(200, 7);
      seed(ra, made === 'changed' ? { 'p.png': V0, 'n.md': 'x' } : { 'n.md': 'x' });
      const pa = ports();
      const A = track(await startNode(ra, 'aaaa', pa, []));
      let B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
      await until(() => B.vault.exists('n.md') && (made === 'created' || B.vault.bin('p.png')?.equals(V0) === true), 10000);
      await sleep(1500);
      await exchange(B);
      await sleep(1500);
      // What B has on disk before the live send: all a kill leaves of its records.
      const agreedFile = path.join(rb, AGREED_HASHES_FILE);
      const before = fs.existsSync(agreedFile) ? fs.readFileSync(agreedFile) : null;
      await A.vault.writeBin('p.png', V1);
      await until(() => is(B, V1), 5000);
      // Killed before its records were written.
      await B.coord.stop();
      nodes = nodes.filter((x) => x !== B);
      if (before) fs.writeFileSync(agreedFile, before);
      else fs.rmSync(agreedFile, { force: true });
      await A.vault.writeBin('p.png', V2);
      await sleep(300);
      await A.vault.rm('p.png');
      await sleep(300);
      const asked: string[] = [];
      const bs = (A.coord as any).binarySync;
      const request = bs.requestFile.bind(bs);
      bs.requestFile = (id: string, p: string, ...rest: unknown[]) => { asked.push(p); return request(id, p, ...rest); };
      B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
      await until(() => !B.vault.exists('p.png'), 8000);
      for (let round = 0; round < 2; round++) {
        await sleep(1500);
        await exchange(B);
        await exchange(A);
      }
      await sleep(1000);
      expect(asked).toEqual([]);
      expect(A.vault.exists('p.png')).toBe(false);
      expect(B.vault.exists('p.png')).toBe(false);
    });
  }
});
