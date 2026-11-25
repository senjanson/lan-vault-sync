/**
 * An attachment changed on two devices at once: neither change is lost.
 * Taking a peer's version over ours reads our copy, keeps it, and only then
 * writes; on a phone keeping the old version takes a while, and a change
 * made here meanwhile was written over without a trace (its modify event
 * was taken for the write's own), so only the version from before both
 * changes was left in the history.
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

const V1 = Buffer.alloc(300, 1);
const V2 = Buffer.alloc(700, 2);
const V3 = Buffer.alloc(500, 3);
const is = (n: Node, v: Buffer) => n.vault.bin('p.png')?.equals(v) === true;
const exchange = (n: Node) => (n.coord as any)._periodicFullSync() as Promise<void>;

/** Mac relays for two phones that only connect to it, as on the devices where this was found. */
async function threeDevices() {
  const rm = tmpRoot('mac'), ri = tmpRoot('iphone'), rp = tmpRoot('pixel');
  seed(rm, { 'p.png': V1 });
  const p = ports();
  const mac = track(await startNode(rm, 'mac0', p, []));
  const iphone = track(await startNode(ri, 'iphn', p + 1, [p]));
  const pixel = track(await startNode(rp, 'pxl0', p + 2, [p]));
  await until(() => is(iphone, V1) && is(pixel, V1), 10000);
  await sleep(500);
  await exchange(iphone);
  await exchange(pixel);
  await sleep(800);
  return { mac, iphone, pixel };
}

/** Every device's copy of p.png and its conflict copies, and what each kept in its history. */
async function versionsOf(n: Node): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const f of fs.readdirSync(n.vault.root)) {
    if (f === 'p.png' || (f.startsWith('p (conflict ') && f.endsWith('.png'))) out.push(fs.readFileSync(`${n.vault.root}/${f}`));
  }
  const store = n.coord.versionStore!;
  await store.flush();
  for (const e of await store.list({ path: 'p.png' })) {
    const bytes = await store.read(e.hash).catch(() => null);
    if (bytes) out.push(Buffer.from(bytes));
  }
  return out;
}

describe('e2e attachment changed on two devices at once', { timeout: 60000 }, () => {
  it('a change made on a phone while it keeps its old copy before taking a peer\'s version is not written over', async () => {
    const { mac, iphone, pixel } = await threeDevices();
    await pixel.vault.writeBin('p.png', V2);
    await until(() => is(mac, V2));
    // The iPhone, still at v1, fetches v2 at its next file list exchange.
    // Keeping v1 takes a while on a phone; the user's v3 lands meanwhile.
    const gate = (iphone.coord as any).gate;
    const keepOld = gate.keepOld.bind(gate);
    let changed = false;
    gate.keepOld = async (path: string, ...rest: unknown[]) => {
      const kept = await keepOld(path, ...rest);
      if (path === 'p.png' && !changed) {
        changed = true;
        await iphone.vault.writeBin('p.png', V3);
      }
      return kept;
    };
    await exchange(iphone);
    await until(() => changed);
    await sleep(1500);
    for (let i = 0; i < 2; i++) {
      await exchange(iphone);
      await exchange(pixel);
      await sleep(1500);
    }
    expect(changed).toBe(true);
    // Both changes are still somewhere: the file, a conflict copy, or a
    // device's history.
    const all = [...(await versionsOf(mac)), ...(await versionsOf(iphone)), ...(await versionsOf(pixel))];
    expect(all.some((b) => b.equals(V3))).toBe(true);
    expect(all.some((b) => b.equals(V2))).toBe(true);
    // And all three end with the same file.
    const final = mac.vault.bin('p.png');
    expect(final).not.toBeNull();
    for (const n of [iphone, pixel]) expect(n.vault.bin('p.png')?.equals(final!)).toBe(true);
  });
});
