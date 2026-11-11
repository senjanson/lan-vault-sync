import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
(globalThis as any).require = createRequire(import.meta.url);
import { TFile, TFolder } from 'obsidian';
import { SyncCoordinator } from '../../src/sync/sync-coordinator';
import { DEFAULT_SETTINGS, LANSyncSettings } from '../../src/types';

// Desktop runtime detection (and the ws server) relies on a global require.

type Handler = (...a: any[]) => void;

/** Disk-backed minimal Obsidian Vault + adapter, firing vault events like Obsidian does. */
export class DiskVault {
  handlers = new Map<string, Set<Handler>>();
  files = new Map<string, TFile>();
  adapter: any;
  constructor(public root: string, public name = 'TestVault') {
    fs.mkdirSync(root, { recursive: true });
    const abs = (p: string) => path.join(root, p);
    this.adapter = {
      exists: async (p: string) => fs.existsSync(abs(p)),
      mkdir: async (p: string) => fs.mkdirSync(abs(p), { recursive: true }),
      write: async (p: string, d: string) => fs.writeFileSync(abs(p), d),
      read: async (p: string) => fs.readFileSync(abs(p), 'utf8'),
      writeBinary: async (p: string, d: ArrayBuffer) => fs.writeFileSync(abs(p), Buffer.from(d)),
      readBinary: async (p: string) => { const b = fs.readFileSync(abs(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
      remove: async (p: string) => fs.rmSync(abs(p)),
      rename: async (a: string, b: string) => fs.renameSync(abs(a), abs(b)),
    };
    this.scan('');
  }
  private scan(dir: string) {
    for (const e of fs.readdirSync(path.join(this.root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (rel.startsWith('.obsidian')) continue; // Obsidian does not index config dir
      if (e.isDirectory()) this.scan(rel); else this.track(rel);
    }
  }
  private track(p: string) {
    const f = new TFile(p); const st = fs.statSync(path.join(this.root, p));
    f.stat = { mtime: st.mtimeMs, size: st.size }; (f as any).vault = this; this.files.set(p, f); return f;
  }
  private abs(p: string) { return path.join(this.root, p); }
  getName() { return this.name; }
  on(ev: string, h: Handler) { if (!this.handlers.has(ev)) this.handlers.set(ev, new Set()); this.handlers.get(ev)!.add(h); return { ev, h }; }
  offref(ref: any) { this.handlers.get(ref.ev)?.delete(ref.h); }
  trigger(ev: string, ...a: any[]) { for (const h of this.handlers.get(ev) ?? []) h(...a); }
  getFiles() { return [...this.files.values()]; }
  getAbstractFileByPath(p: string): any { return this.files.get(p) ?? this.folder(p); }
  /** Folders come straight from disk, with their children, like Obsidian's tree. */
  folder(p: string): TFolder | null {
    if (!p || p.startsWith('.obsidian') || !fs.existsSync(this.abs(p)) || !fs.statSync(this.abs(p)).isDirectory()) return null;
    const f = new TFolder(p);
    f.children = fs.readdirSync(this.abs(p)).map((n) => this.getAbstractFileByPath(`${p}/${n}`)).filter(Boolean);
    return f;
  }
  getAllLoadedFiles(): any[] {
    const out: any[] = [];
    const walk = (dir: string) => { for (const e of fs.readdirSync(this.abs(dir), { withFileTypes: true })) { const rel = dir ? `${dir}/${e.name}` : e.name; if (rel.startsWith('.obsidian')) continue; if (e.isDirectory()) { out.push(this.folder(rel)); walk(rel); } else if (this.files.has(rel)) out.push(this.files.get(rel)); } };
    walk('');
    return out;
  }
  async createFolder(p: string) { if (fs.existsSync(this.abs(p))) throw new Error('Folder already exists.'); this.parentOk(p); fs.mkdirSync(this.abs(p)); this.trigger('create', this.folder(p)); }
  /** Delete a folder with everything in it, firing events for each item, as Obsidian does. */
  async deleteFolder(p: string) {
    const folder = this.folder(p)!;
    for (const c of folder.children) { if (c instanceof TFolder) await this.deleteFolder(c.path); else { this.files.delete(c.path); fs.rmSync(this.abs(c.path)); this.trigger('delete', c); } }
    fs.rmdirSync(this.abs(p)); this.trigger('delete', folder);
  }
  async renameFolder(p: string, np: string) {
    const moved = [...this.files.keys()].filter((k) => k.startsWith(p + '/'));
    this.parentOk(np); fs.renameSync(this.abs(p), this.abs(np));
    this.trigger('rename', this.folder(np), p);
    for (const old of moved) { this.files.delete(old); const nf = this.track(np + old.slice(p.length)); this.trigger('rename', nf, old); }
  }
  async cachedRead(f: TFile) { return fs.readFileSync(this.abs(f.path), 'utf8'); }
  async read(f: TFile) { return this.cachedRead(f); }
  async readBinary(f: TFile) { return this.adapter.readBinary(f.path); }
  private parentOk(p: string) { const d = path.dirname(this.abs(p)); if (!fs.existsSync(d)) throw new Error('Parent folder missing: ' + p); }
  async create(p: string, c: string) { if (this.files.has(p)) throw new Error('File already exists.'); this.parentOk(p); fs.writeFileSync(this.abs(p), c); const f = this.track(p); this.trigger('create', f); return f; }
  async createBinary(p: string, c: ArrayBuffer) { if (this.files.has(p)) throw new Error('File already exists.'); this.parentOk(p); fs.writeFileSync(this.abs(p), Buffer.from(c)); const f = this.track(p); this.trigger('create', f); return f; }
  async modify(f: TFile, c: string) { fs.writeFileSync(this.abs(f.path), c); this.track(f.path); this.trigger('modify', this.files.get(f.path)); }
  async modifyBinary(f: TFile, c: ArrayBuffer) { fs.writeFileSync(this.abs(f.path), Buffer.from(c)); this.track(f.path); this.trigger('modify', this.files.get(f.path)); }
  async delete(f: any, _force?: boolean) { if (f instanceof TFolder) return this.deleteFolder(f.path); return this.deleteFile(f); }
  async deleteFile(f: TFile) { fs.rmSync(this.abs(f.path)); this.files.delete(f.path); this.trigger('delete', f); }
  async rename(f: TFile, np: string) { const old = f.path; this.parentOk(np); fs.renameSync(this.abs(old), this.abs(np)); this.files.delete(old); const nf = this.track(np); this.trigger('rename', nf, old); }
  // ── "user" helpers (go through the vault API like the editor would)
  async write(p: string, c: string) { const f = this.files.get(p); if (f) return this.modify(f, c); fs.mkdirSync(path.dirname(this.abs(p)), { recursive: true }); return this.create(p, c); }
  async writeBin(p: string, c: Uint8Array) { const f = this.files.get(p); const ab = c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer; if (f) return this.modifyBinary(f, ab); fs.mkdirSync(path.dirname(this.abs(p)), { recursive: true }); return this.createBinary(p, ab); }
  text(p: string) { const a = this.abs(p); return fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : null; }
  bin(p: string) { const a = this.abs(p); return fs.existsSync(a) ? fs.readFileSync(a) : null; }
  exists(p: string) { return fs.existsSync(this.abs(p)); }
  async rm(p: string) { return this.delete(this.files.get(p)!); }
  async mv(a: string, b: string) { fs.mkdirSync(path.dirname(this.abs(b)), { recursive: true }); return this.rename(this.files.get(a)!, b); }
}

export interface Node { vault: DiskVault; coord: SyncCoordinator; settings: LANSyncSettings; events: string[]; }

export function tmpRoot(tag: string) { return fs.mkdtempSync(path.join(os.tmpdir(), `lvs-${tag}-`)); }

export async function startNode(root: string, deviceId: string, port: number, peers: number[], extra: Partial<LANSyncSettings> = {}): Promise<Node> {
  const vault = new DiskVault(root);
  const settings: LANSyncSettings = { ...DEFAULT_SETTINGS, ignoredPaths: [...DEFAULT_SETTINGS.ignoredPaths], deviceId, deviceName: deviceId, port, manualPeers: peers.map((p) => `127.0.0.1:${p}`), syncIntervalMs: 0, syncKey: 'TEST-KEY', ...extra };
  const coord = new SyncCoordinator(vault as any, settings);
  const events: string[] = [];
  coord.onSyncEvent((m) => events.push(m));
  await coord.start();
  return { vault, coord, settings, events };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nextPort = 42000 + Math.floor(Math.random() * 15000);
/** Reserve a block of three consecutive ports for one scenario. */
export const ports = () => { nextPort += 3; return nextPort; };

export function seed(root: string, files: Record<string, string | Buffer>) {
  for (const [p, c] of Object.entries(files)) {
    const a = path.join(root, p);
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.writeFileSync(a, c);
  }
}

export const count = (n: Node, prefix: string) => n.events.filter((e) => e.startsWith(prefix)).length;

/**
 * A raw protocol client, used to act as an untrusted device on the LAN. With
 * a key it completes the pairing check (a device that knows the key).
 */
export async function connectRaw(port: number, handshake: Record<string, unknown>, key?: string) {
  const { encodeHandshake, encodeAuth, decodeMessage, decodeJSON } = await import('../../src/transport/protocol');
  const { authProof, authMessage, randomNonce } = await import('../../src/transport/auth');
  const WS = (globalThis as any).require('ws');
  const ws = new WS(`ws://127.0.0.1:${port}`);
  const received: Array<{ type: number; payload: Uint8Array }> = [];
  let closed = false;
  const nonce = randomNonce();
  ws.on('message', async (raw: Buffer) => {
    const msg = decodeMessage(new Uint8Array(raw));
    received.push(msg);
    if (key && msg.type === 0x01) {
      const ack = decodeJSON<{ nonce?: string }>(msg.payload);
      if (ack.nonce) ws.send(encodeAuth({ proof: await authProof(key, authMessage(ack.nonce, nonce, String(handshake.deviceId))) }));
    }
  });
  ws.on('close', () => { closed = true; });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(encodeHandshake({ deviceName: 'rogue', port: 1, nonce, ...handshake } as any));
  await sleep(300);
  return { ws, received, isClosed: () => closed, send: (data: Uint8Array) => ws.send(data) };
}
