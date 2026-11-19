/**
 * Fault injection (plan 6.5): random edits on three devices while messages
 * are dropped, sent twice or held back, devices restart with half-written
 * state files, and one device's clock runs behind. Once the faults stop,
 * the devices must agree, and every version any device had must still be
 * somewhere: in the vault, in a conflict copy, or in the version history.
 *
 * Each run prints its seed; FAULT_SEEDS=7,8 runs others.
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
import zlib from 'node:zlib';
import { MessageType } from '../../src/types';
import { FILE_INDEX_FILE, AGREED_HASHES_FILE } from '../../src/constants';
import { Node, ports, seed, sleep, startNode, tmpRoot, until } from './harness';

let nodes: Node[] = [];
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Faults { on: boolean; drop: number; dup: number; hold: number }

/** Wraps a node's sends: drop, send twice, or hold one back until the next. */
function injectFaults(n: Node, rand: () => number, faults: Faults) {
  const cm = (n.coord as any).connectionManager;
  const held = new Map<string, () => void>();
  const wrap = (name: string, keyOf: (args: any[]) => string, dataAt: number) => {
    const orig = cm[name]?.bind(cm);
    if (!orig) return;
    cm[name] = (...args: any[]) => {
      const data = args[dataAt];
      const type = data instanceof Uint8Array ? data[0] : undefined;
      // A chunk stream is one WebSocket stream: chunks never arrive out of
      // order or twice there, so they are only ever lost with the rest.
      const chunk = type === MessageType.FILE_CHUNK;
      if (!faults.on || type === undefined) return orig(...args);
      const r = rand();
      if (r < faults.drop) return undefined;
      if (chunk) return orig(...args);
      if (r < faults.drop + faults.dup) {
        orig(...args);
        return orig(...args);
      }
      const key = keyOf(args);
      if (r < faults.drop + faults.dup + faults.hold && !held.has(key)) {
        held.set(key, () => orig(...args));
        return undefined;
      }
      const out = orig(...args);
      const late = held.get(key);
      if (late) {
        held.delete(key);
        late();
      }
      return out;
    };
  };
  wrap('sendTo', (a) => a[0], 1);
  wrap('broadcast', () => '*', 0);
  // A large file goes as one paced stream of chunks: lost whole, if at all.
  const paced = cm.sendToPaced?.bind(cm);
  if (paced) cm.sendToPaced = (...args: any[]) => (faults.on && rand() < faults.drop ? Promise.resolve(true) : paced(...args));
  return () => {
    for (const late of held.values()) late();
    held.clear();
  };
}

function visibleFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (rel.startsWith('.')) continue;
      if (e.isDirectory()) walk(rel);
      else out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex'));
    }
  };
  walk('');
  return out;
}

/** Everything a device keeps: its vault files and its version history, unpacked. */
function corpus(root: string): { text: string; hashes: Set<string> } {
  let text = '';
  const hashes = new Set<string>();
  const walk = (dir: string) => {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (rel.startsWith('.obsidian') || rel.startsWith('.trash')) continue;
      if (e.isDirectory()) { walk(rel); continue; }
      let buf = fs.readFileSync(path.join(root, rel));
      hashes.add(crypto.createHash('sha256').update(buf).digest('hex'));
      for (const unpack of [zlib.gunzipSync, zlib.inflateSync]) {
        try { buf = unpack(buf); hashes.add(crypto.createHash('sha256').update(buf).digest('hex')); break; } catch { /* not packed */ }
      }
      text += buf.toString('utf8') + '\n';
    }
  };
  walk('');
  return { text, hashes };
}

async function runSeed(seedNo: number) {
  const rand = rng(seedNo);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const roots = ['a', 'b', 'c'].map((t) => tmpRoot(`f${seedNo}${t}`));
  const ids = ['aaaa', 'bbbb', 'cccc'];
  const base: Record<string, string> = {};
  for (let i = 0; i < 4; i++) base[`n${i}.md`] = `# n${i}\nbase FK${seedNo}_b${i}_\n`;
  seed(roots[0], base);
  const p0 = ports();
  const fast = { syncIntervalMs: 500 };
  const start = (i: number) =>
    startNode(roots[i], ids[i], p0 + i, [0, 1, 2].filter((j) => j !== i).map((j) => p0 + j), fast);
  const live: Node[] = [];
  for (let i = 0; i < 3; i++) live[i] = await start(i);
  nodes.push(...live);
  await until(() => live.every((n) => Object.keys(base).every((p) => n.vault.text(p) === base[p])), 15000);

  const faults: Faults = { on: true, drop: 0.1, dup: 0.1, hold: 0.1 };
  const release: Array<() => void> = live.map((n) => injectFaults(n, rand, faults));
  const markers: string[] = [];
  const binaries: string[] = [];
  const own = new Map<string, string>();
  const log: string[] = [];

  for (let i = 0; i < 30; i++) {
    const k = Math.floor(rand() * 3);
    const n = live[k];
    const r = rand();
    const notes = [...n.vault.files.keys()].filter((p) => p.endsWith('.md') && !p.includes('(conflict'));
    if (r < 0.45 && notes.length) {
      const p = pick(notes);
      const m = `FK${seedNo}_${i}_`;
      const now = n.vault.text(p);
      if (now === null) continue;
      await n.vault.write(p, `${now}\n${m} on ${ids[k]}`);
      // The third device's clock is two minutes behind.
      if (k === 2) { const t = new Date(Date.now() - 120_000); fs.utimesSync(path.join(roots[k], p), t, t); }
      markers.push(m);
      log.push(`${i}: append ${m} to ${p} on ${ids[k]}`);
    } else if (r < 0.6) {
      const p = `new${i}.md`;
      const m = `FK${seedNo}_${i}_`;
      await n.vault.write(p, `${m} new on ${ids[k]}\n`);
      markers.push(m);
      log.push(`${i}: create ${p} on ${ids[k]}`);
    } else if (r < 0.8) {
      const p = `bin${Math.floor(rand() * 2)}.png`;
      const bytes = crypto.randomBytes(rand() < 0.15 ? 9 * 1024 * 1024 : 64 + Math.floor(rand() * 4000));
      // Writing over our own version that no other device has got yet is
      // the user replacing it, as an edit replaces a note's text: that
      // version is not owed to anyone.
      const cur = n.vault.bin(p);
      if (cur) {
        const h = crypto.createHash('sha256').update(cur).digest('hex');
        const mine = own.get(`${k}\n${p}`);
        if (h === mine && !roots.some((r, j) => j !== k && corpus(r).hashes.has(h))) {
          binaries.splice(binaries.indexOf(h), 1);
        }
      }
      await n.vault.writeBin(p, bytes);
      const h = crypto.createHash('sha256').update(bytes).digest('hex');
      own.set(`${k}\n${p}`, h);
      binaries.push(h);
      log.push(`${i}: write ${p} on ${ids[k]}`);
    } else if (r < 0.9) {
      // A crash in the middle of saving state: the file is cut in half.
      release[k]();
      await n.coord.stop();
      for (const f of [FILE_INDEX_FILE, AGREED_HASHES_FILE]) {
        const abs = path.join(roots[k], f);
        if (fs.existsSync(abs)) fs.writeFileSync(abs, fs.readFileSync(abs).subarray(0, Math.floor(fs.statSync(abs).size / 2)));
      }
      nodes = nodes.filter((x) => x !== n);
      live[k] = await start(k);
      nodes.push(live[k]);
      release[k] = injectFaults(live[k], rand, faults);
      log.push(`${i}: crash and restart ${ids[k]} with half-written state`);
    } else {
      await sleep(300);
    }
    await sleep(50 + Math.floor(rand() * 200));
  }

  faults.on = false;
  for (const r of release) r();
  const same = () => {
    const [a, ...rest] = roots.map(visibleFiles);
    return rest.every((b) => b.size === a.size && [...a].every(([p, h]) => b.get(p) === h));
  };
  await until(same, 30000);
  const what = `seed ${seedNo}:\n${log.join('\n')}`;
  if (!same()) {
    const lists = roots.map(visibleFiles);
    const paths = new Set(lists.flatMap((l) => [...l.keys()]));
    for (const p of paths) {
      const hs = lists.map((l) => l.get(p)?.slice(0, 8) ?? '-');
      if (new Set(hs).size > 1) console.log(`differs: ${p} ${hs.join(' ')}`);
    }
  }
  expect(same(), `devices differ after the faults stopped; ${what}`).toBe(true);

  const kept = roots.map(corpus);
  const text = kept.map((c) => c.text).join('\n');
  const lost = markers.filter((m) => !text.includes(m));
  expect(lost, `lost edits; ${what}`).toEqual([]);
  const lostBin = binaries.filter((h) => !kept.some((c) => c.hashes.has(h)));
  expect(lostBin, `lost attachment versions; ${what}`).toEqual([]);
}

const SEEDS = (process.env.FAULT_SEEDS ?? '1,2,3').split(',').map(Number);

describe('fault injection', { timeout: 120000 }, () => {
  for (const s of SEEDS) {
    it(`seed ${s}: devices agree and keep every version despite lost, doubled and late messages, crashes and a slow clock`, async () => {
      console.log(`fault injection seed ${s}`);
      await runSeed(s);
    });
  }
});
