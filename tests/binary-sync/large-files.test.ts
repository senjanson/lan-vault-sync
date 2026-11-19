/**
 * Large files (plan 6.4): chunks are sent one at a time and written to a
 * temporary file as they arrive, the whole file is checked against the hash
 * the sender gave before it replaces anything, and files over the receive
 * limit are refused before any of them is kept.
 */
import { describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { BinaryFileSyncService } from '../../src/binary-sync/binary-sync-service';
import { computeFileHash } from '../../src/binary-sync/file-hash';
import { decodeFileChunk, decodeMessage, encodeFileChunk } from '../../src/transport/protocol';
import { ApplyGate, BackupKeeper } from '../../src/sync/apply-gate';
import { EventLog } from '../../src/diagnostics/event-log';
import { CHUNK_SIZE, INCOMING_DIR } from '../../src/constants';
import { MessageType } from '../../src/types';

const MB = 1024 * 1024;

/** A vault whose adapter keeps hidden files (like .lan-vault-sync) apart from the vault's own. */
class FakeVault {
  files = new Map<string, { file: TFile; content: Uint8Array }>();
  hidden = new Map<string, Uint8Array>();
  appends = 0;
  adapter: any;

  constructor(opts: { append?: boolean } = {}) {
    const hidden = this.hidden;
    this.adapter = {
      exists: async (p: string) => hidden.has(p) || [...hidden.keys()].some((k) => k.startsWith(p + '/')),
      mkdir: async () => undefined,
      writeBinary: async (p: string, d: ArrayBuffer) => { hidden.set(p, new Uint8Array(d.slice(0))); },
      readBinary: async (p: string) => {
        const b = hidden.get(p);
        if (!b) throw new Error('missing ' + p);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      remove: async (p: string) => { hidden.delete(p); },
      list: async (p: string) => ({
        files: [...hidden.keys()].filter((k) => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')),
        folders: [],
      }),
    };
    if (opts.append !== false) {
      this.adapter.appendBinary = async (p: string, d: ArrayBuffer) => {
        this.appends++;
        const old = hidden.get(p) ?? new Uint8Array();
        const next = new Uint8Array(old.byteLength + d.byteLength);
        next.set(old, 0);
        next.set(new Uint8Array(d), old.byteLength);
        hidden.set(p, next);
      };
    }
  }

  setBinary(path: string, content: Uint8Array): TFile {
    const file = this.files.get(path)?.file ?? new TFile(path);
    file.stat.size = content.byteLength;
    this.files.set(path, { file, content });
    return file;
  }
  get(path: string): Uint8Array | null {
    return this.files.get(path)?.content ?? null;
  }
  getAbstractFileByPath(path: string): TFile | null {
    return this.files.get(path)?.file ?? null;
  }
  getFiles(): TFile[] {
    return [...this.files.values()].map((e) => e.file);
  }
  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const c = this.files.get(file.path)!.content;
    return c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer;
  }
  async modifyBinary(file: TFile, content: ArrayBuffer): Promise<void> {
    this.setBinary(file.path, new Uint8Array(content));
  }
  async createBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.setBinary(path, new Uint8Array(content));
  }
  incomingFiles(): string[] {
    return [...this.hidden.keys()].filter((k) => k.startsWith(INCOMING_DIR + '/'));
  }
}

/** Byte equality; toEqual walks a typed array key by key and runs out of memory at this size. */
function same(a: Uint8Array | null, b: Uint8Array): boolean {
  return !!a && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function bytes(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >> 16;
  }
  return out;
}

function setup(opts: { append?: boolean; limitBytes?: number } = {}) {
  const vault = new FakeVault(opts);
  const log = new EventLog(null);
  const cm = {
    broadcast: vi.fn(),
    sendTo: vi.fn(),
    getConnectedPeerIds: () => ['peer'],
    isConnectedTo: () => true,
    receiveLimitBytes: () => opts.limitBytes ?? 0,
    sendToPaced: vi.fn(async (_id: string, frames: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) => {
      for await (const f of frames) sent.push(f);
      return true;
    }),
  };
  const sent: Uint8Array[] = [];
  const backupBinaryFile = vi.fn().mockResolvedValue({ backupId: 'b1' });
  const service = new BinaryFileSyncService(vault as any, cm as any, { backupBinaryFile } as any);
  service.setGate(new ApplyGate({ vault: vault as any, keeper: new BackupKeeper({ backupBinaryFile } as any), log }));
  return { vault, log, cm, sent, service, backupBinaryFile };
}

/** The FILE_CHUNK payloads a sender would make for `content`. */
async function chunksOf(path: string, content: Uint8Array, hash?: string): Promise<Uint8Array[]> {
  const h = hash ?? (await computeFileHash(content.buffer.slice(0) as ArrayBuffer));
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < content.byteLength; offset += CHUNK_SIZE) {
    const msg = encodeFileChunk({
      path, mtime: 1000, totalSize: content.byteLength, offset,
      content: content.subarray(offset, offset + CHUNK_SIZE),
      ...(offset === 0 ? { hash: h, madeAt: 1000 } : {}),
    });
    out.push(decodeMessage(msg).payload);
  }
  return out;
}

async function deliver(service: BinaryFileSyncService, payloads: Uint8Array[], from = 'peer') {
  for (const p of payloads) await service.handleMessage(from, MessageType.FILE_CHUNK, p);
}

describe('large files: receiving', () => {
  it('writes chunks to a temporary file, then stores the whole file and removes the temporary one', async () => {
    const { vault, service } = setup();
    const content = bytes(10 * MB + 123);
    const payloads = await chunksOf('big.bin', content);
    await deliver(service, payloads.slice(0, 3));
    // While the transfer runs, the received part sits on disk, not in memory.
    expect(vault.incomingFiles()).toHaveLength(1);
    expect(vault.hidden.get(vault.incomingFiles()[0])!.byteLength).toBe(3 * CHUNK_SIZE);
    await deliver(service, payloads.slice(3));
    expect(vault.appends).toBeGreaterThan(0);
    expect(same(vault.get('big.bin'), content)).toBe(true);
    expect(vault.incomingFiles()).toEqual([]);
  });

  it('keeps chunks in memory when the adapter cannot append', async () => {
    const { vault, service } = setup({ append: false });
    const content = bytes(9 * MB, 7);
    await deliver(service, await chunksOf('m.bin', content));
    expect(same(vault.get('m.bin'), content)).toBe(true);
    expect(vault.incomingFiles()).toEqual([]);
  });

  it('discards a file whose content does not match the sender\'s hash, and leaves the old one', async () => {
    const { vault, service, log, backupBinaryFile } = setup();
    const old = bytes(100, 3);
    vault.setBinary('c.bin', old);
    const content = bytes(9 * MB, 4);
    const payloads = await chunksOf('c.bin', content);
    // One chunk is damaged on the way: same size, different bytes.
    const bad = decodeFileChunk(payloads[2]);
    bad.content = new Uint8Array(bad.content.byteLength).fill(0xee);
    payloads[2] = decodeMessage(encodeFileChunk(bad)).payload;
    await deliver(service, payloads);
    expect(same(vault.get('c.bin'), old)).toBe(true);
    expect(backupBinaryFile).not.toHaveBeenCalled();
    expect(vault.incomingFiles()).toEqual([]);
    expect(log.recentRecords().some((r) => r.path === 'c.bin' && r.level === 'warn' && r.rule === 'bad-hash')).toBe(true);
  });

  it('refuses a file over the receive limit at its first chunk', async () => {
    const { vault, service, log } = setup({ limitBytes: 5 * MB });
    const old = bytes(100, 5);
    vault.setBinary('huge.bin', old);
    const content = bytes(9 * MB, 6);
    const payloads = await chunksOf('huge.bin', content);
    await deliver(service, payloads.slice(0, 1));
    // Nothing of it is kept, on disk or in memory.
    expect(vault.incomingFiles()).toEqual([]);
    expect((service as any).incoming.size).toBe(0);
    await deliver(service, payloads.slice(1));
    expect(vault.appends).toBe(0);
    expect(same(vault.get('huge.bin'), old)).toBe(true);
    const rec = log.recentRecords().find((r) => r.rule === 'too-large');
    expect(rec).toMatchObject({ op: 'skip', level: 'warn', path: 'huge.bin', rule: 'too-large' });
    expect(rec!.msg).toBeTruthy();
  });

  it('takes files under the limit', async () => {
    const { vault, service } = setup({ limitBytes: 50 * MB });
    const content = bytes(9 * MB, 8);
    await deliver(service, await chunksOf('ok.bin', content));
    expect(same(vault.get('ok.bin'), content)).toBe(true);
  });

  it('removes a peer\'s partial file when it disconnects', async () => {
    const { vault, service } = setup();
    const payloads = await chunksOf('p.bin', bytes(9 * MB, 9));
    await deliver(service, payloads.slice(0, 2), 'gone');
    expect(vault.incomingFiles()).toHaveLength(1);
    service.dropIncoming('gone');
    await vi.waitFor(() => expect(vault.incomingFiles()).toEqual([]));
    await deliver(service, payloads.slice(2), 'gone');
    expect(vault.get('p.bin')).toBeNull();
  });

  it('removes temporary files left from an earlier run when it starts', async () => {
    const vault = new FakeVault();
    vault.hidden.set(`${INCOMING_DIR}/old-peer-1.part`, new Uint8Array([1, 2, 3]));
    const service = new BinaryFileSyncService(vault as any, { broadcast: vi.fn(), sendTo: vi.fn() } as any, {} as any);
    await (service as any).incomingCleaned;
    expect(vault.incomingFiles()).toEqual([]);
  });
});

describe('large files: sending', () => {
  it('sends a large file as chunks through the paced send, built one at a time', async () => {
    const { vault, service, cm, sent } = setup();
    const content = bytes(20 * MB + 5, 11);
    vault.setBinary('big.bin', content);
    await service.sendFileToPeer('peer', 'big.bin');
    await service.outgoingIdle();
    expect(cm.sendToPaced).toHaveBeenCalledTimes(1);
    const frames = cm.sendToPaced.mock.calls[0][1];
    expect(Array.isArray(frames)).toBe(false);
    expect(cm.sendTo).not.toHaveBeenCalled();
    const chunks = sent.map((m) => decodeFileChunk(decodeMessage(m).payload));
    expect(chunks.length).toBe(Math.ceil(content.byteLength / CHUNK_SIZE));
    const joined = new Uint8Array(content.byteLength);
    for (const c of chunks) joined.set(c.content, c.offset);
    expect(same(joined, content)).toBe(true);
    expect(chunks[0].hash).toBe(await computeFileHash(content.buffer.slice(0) as ArrayBuffer));
  });

  it('broadcasts a large change to each connected peer through the paced send', async () => {
    const { vault, service, cm } = setup();
    vault.setBinary('big.bin', bytes(9 * MB, 12));
    const hash = await service.broadcastFileChange('big.bin');
    await service.outgoingIdle();
    expect(hash).toBeTruthy();
    expect(cm.broadcast).not.toHaveBeenCalled();
    expect(cm.sendToPaced).toHaveBeenCalledWith('peer', expect.anything());
  });

  it('still sends small files as one message', async () => {
    const { vault, service, cm } = setup();
    vault.setBinary('s.bin', bytes(1000, 13));
    await service.sendFileToPeer('peer', 's.bin');
    await service.outgoingIdle();
    expect(cm.sendTo).toHaveBeenCalledTimes(1);
    expect(cm.sendToPaced).not.toHaveBeenCalled();
  });
});
