/**
 * End-to-end scenarios for files a device cannot store, folders left behind
 * by bulk deletes, and the file system work done per file in bulk changes
 * (see harness.ts for the test vaults).
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
import { decodeJSON, decodeMessage, decodeYjsSync, encodeFileDelete, encodeFileMetaSync, encodeFolderOp, encodeYjsSync } from '../../src/transport/protocol';
import { computeFileHash } from '../../src/binary-sync/file-hash';
import { FileMeta, MessageType } from '../../src/types';
import { connectRaw, Node, ports, seed, sleep, startNode, tmpRoot, until } from './harness';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

const hashOf = (data: string | Uint8Array) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return computeFileHash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
};
/** Lets a test delete most of a vault without the bulk-deletion hold. */
const noHold = { deleteLimits: { incomingShare: 2, inferredMax: 1e9 } };
const names = (root: string) => fs.readdirSync(root).filter((f) => !f.startsWith('.')).sort();
const raw = (n: Node, port: number) => connectRaw(port, { deviceId: 'peer', vaultId: (n.coord as any).vaultId }, 'TEST-KEY');
const tree = (files: FileMeta[], folders: string[] = [], deleted: any[] = []) => encodeFileMetaSync({ files, folders, deleted });
/** Paths of the files a device asked a raw peer for. */
const asked = (received: Array<{ type: number; payload: Uint8Array }>) => received
  .filter((m) => m.type === MessageType.YJS_SYNC_STEP1 || m.type === MessageType.FILE_REQUEST)
  .map((m) => (m.type === MessageType.FILE_REQUEST ? new TextDecoder().decode(m.payload) : decodeYjsSync(m.payload).filePath));

describe('e2e names a device cannot store', { timeout: 30000 }, () => {
  it('tells once that a file whose name Obsidian refuses cannot be synced, and syncs the rest', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'a:b.md': 'colon\n', 'why?.png': Buffer.from([1]), 'q "x" <y>.md': 'quotes\n', 'ok.md': 'fine\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await until(() => B.vault.text('ok.md') === 'fine\n');
    for (let round = 0; round < 3; round++) {
      await (A.coord as any)._periodicFullSync();
      await (B.coord as any)._periodicFullSync();
      await sleep(300);
    }
    expect(names(rb)).toEqual(['ok.md']);
    expect(names(ra)).toEqual(['a:b.md', 'ok.md', 'q "x" <y>.md', 'why?.png']);
    for (const p of ['a:b.md', 'why?.png', 'q "x" <y>.md']) {
      expect(A.events.filter((e) => e.startsWith(`Cannot sync ${p}:`))).toHaveLength(1);
      expect(A.events.some((e) => e.startsWith('Sending') && e.endsWith(p))).toBe(false);
      expect(B.events.some((e) => e.startsWith('Requesting') && e.endsWith(p))).toBe(false);
    }
    expect(A.events.find((e) => e.startsWith('Cannot sync a:b.md'))).toMatch(/":"/);

    // Renamed to a name every device takes, it syncs.
    await A.vault.mv('a:b.md', 'a-b.md');
    await (A.coord as any)._periodicFullSync();
    await until(() => B.vault.text('a-b.md') === 'colon\n');
    expect(B.vault.text('a-b.md')).toBe('colon\n');
  });

  it('tells once that a peer\'s file names Obsidian refuses cannot be stored, and never asks for them', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'ok.md': 'fine\n' });
    const pb = ports();
    const B = track(await startNode(rb, 'bbbb', pb, []));
    const peer = await raw(B, pb);
    const list = tree([
      { path: 'ok.md', hash: await hashOf('fine\n'), mtime: 1, size: 5, isTextFile: true },
      { path: 'a:b.md', hash: 'f'.repeat(64), mtime: 1, size: 3, isTextFile: true },
      { path: 'pic*.png', hash: 'e'.repeat(64), mtime: 1, size: 3, isTextFile: false },
    ]);
    for (let round = 0; round < 3; round++) { peer.send(list); await sleep(300); }
    // The peer sends one anyway.
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'theirs\n');
    peer.send(encodeYjsSync(MessageType.YJS_FULL_STATE, 'a:b.md', Y.encodeStateAsUpdate(doc)));
    await sleep(500);
    peer.ws.close();
    expect(asked(peer.received)).toEqual([]);
    expect(B.events.filter((e) => e.startsWith('Cannot sync a:b.md:'))).toHaveLength(1);
    expect(B.events.filter((e) => e.startsWith('Cannot sync pic*.png:'))).toHaveLength(1);
    expect(names(rb)).toEqual(['ok.md']);
  });

  it('syncs a file once the one whose name differs only in case is renamed', async () => {
    const rb = tmpRoot('b');
    seed(rb, { 'ReadMe.md': 'mine\n' });
    const pb = ports();
    const B = track(await startNode(rb, 'bbbb', pb, []));
    const peer = await raw(B, pb);
    const theirs = new Y.Doc();
    theirs.getText('content').insert(0, 'theirs\n');
    const list = tree([
      { path: 'ReadMe.md', hash: await hashOf('mine\n'), mtime: 1, size: 5, isTextFile: true },
      { path: 'readme.md', hash: await hashOf('theirs\n'), mtime: 2, size: 7, isTextFile: true },
    ]);
    peer.send(list);
    // Sent while it cannot be stored here.
    peer.send(encodeYjsSync(MessageType.YJS_FULL_STATE, 'readme.md', Y.encodeStateAsUpdate(theirs)));
    await sleep(600);
    expect(asked(peer.received)).not.toContain('readme.md');
    expect(names(rb)).toEqual(['ReadMe.md']);

    await B.vault.mv('ReadMe.md', 'Mine.md');
    await sleep(300);
    peer.send(list);
    await until(() => asked(peer.received).includes('readme.md'));
    expect(asked(peer.received)).toContain('readme.md');
    // Answer the request as a peer does.
    peer.send(encodeYjsSync(MessageType.YJS_SYNC_STEP2, 'readme.md', Y.encodeStateAsUpdate(theirs)));
    await until(() => B.vault.text('readme.md') === 'theirs\n');
    peer.ws.close();
    expect(B.vault.text('readme.md')).toBe('theirs\n');
    expect(B.vault.text('Mine.md')).toBe('mine\n');
  });
});

describe('e2e folders deleted on a peer', { timeout: 30000 }, () => {
  it('removes a deleted folder once its files are gone, however long they take, and keeps one with files the peer never had', async () => {
    const rb = tmpRoot('b');
    const files = ['d5/a.md', 'd5/b.png', 'd6/n.md', 'd6/img/x.png', 'd6/img/y.png'];
    seed(rb, { ...Object.fromEntries(files.map((f) => [f, f.endsWith('.md') ? 'text\n' : Buffer.from([7])])), 'd7/mine.md': 'mine\n', 'keep/k.md': 'k\n' });
    const pb = ports();
    const B = track(await startNode(rb, 'bbbb', pb, [], {}, noHold));
    const peer = await raw(B, pb);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // A slow device: the folders' deletions come first, their files'
      // over the next minutes.
      for (const folder of ['d5', 'd6/img', 'd6', 'd7']) peer.send(encodeFolderOp(MessageType.FOLDER_DELETE, folder));
      await sleep(300);
      for (const file of files) {
        vi.setSystemTime(Date.now() + 40_000);
        // Protocol 3: a deletion names the content it removes.
        peer.send(encodeFileDelete({ path: file, hash: await hashOf(file.endsWith('.md') ? 'text\n' : new Uint8Array([7])) }));
        await sleep(300);
      }
      // (The clock only moves when set, so no until() here.)
      await sleep(1500);
    } finally {
      vi.useRealTimers();
    }
    peer.ws.close();
    expect(names(rb)).toEqual(['d7', 'keep']);
    expect(B.vault.text('d7/mine.md')).toBe('mine\n');
  });

  it('does not bring back the subfolders of a folder deleted here', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    for (const root of [ra, rb]) seed(root, { 'd6/img/x.png': Buffer.from([1]), 'd6/n.md': 'n\n', 'other.md': 'o\n' });
    const pa = ports();
    let A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(800);
    await A.coord.stop();
    nodes = nodes.filter((n) => n !== A);
    // Deleted on B while A is away; only the outer folder is reported as
    // deleted, besides the files.
    for (const f of ['d6/img/x.png', 'd6/n.md']) await B.vault.rm(f);
    fs.rmSync(path.join(rb, 'd6'), { recursive: true });
    B.vault.trigger('delete', new TFolder('d6'));
    await sleep(300);
    A = track(await startNode(ra, 'aaaa', pa, []));
    await until(() => !A.vault.exists('d6'));
    await sleep(800);
    await (A.coord as any)._periodicFullSync();
    await (B.coord as any)._periodicFullSync();
    await sleep(800);
    expect(names(ra)).toEqual(['other.md']);
    expect(names(rb)).toEqual(['other.md']);
  });
});

/** Every folder and file under a vault's root, folders ending in "/". */
const listing = (root: string) => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = d ? `${d}/${e.name}` : e.name;
      if ((rel.startsWith('.obsidian') || rel.startsWith('.lan-vault-sync'))) continue;
      out.push(e.isDirectory() ? `${rel}/` : rel);
      if (e.isDirectory()) walk(rel);
    }
  };
  walk('');
  return out.sort();
};

/** Like Obsidian: a folder made through the adapter shows up in the vault, with its event. */
function folderEventsOnMkdir(n: Node) {
  const mkdir = n.vault.adapter.mkdir;
  n.vault.adapter.mkdir = async (p: string) => {
    const made: string[] = [];
    for (let sub = p; sub && !n.vault.exists(sub); sub = path.posix.dirname(sub) === '.' ? '' : path.posix.dirname(sub)) made.unshift(sub);
    await mkdir(p);
    for (const sub of made) n.vault.trigger('create', n.vault.folder(sub));
  };
}

/** Folder creations a node sent its peers. */
function sentFolderCreates(n: Node) {
  const sent: string[] = [];
  const cm = (n.coord as any).connectionManager;
  const broadcast = cm.broadcast.bind(cm);
  cm.broadcast = (msg: Uint8Array) => {
    const m = decodeMessage(msg);
    if (m.type === MessageType.FOLDER_CREATE) sent.push(decodeJSON<{ path: string }>(m.payload).path);
    return broadcast(msg);
  };
  return sent;
}

describe('e2e large folder deleted on a slow device', { timeout: 90000 }, () => {
  it('fetches back none of the files while their deletions wait their turn, and leaves no folders behind', async () => {
    const files: Record<string, string | Buffer> = { 'other.md': 'other\n' };
    for (let d = 0; d < 4; d++) {
      for (let s = 0; s < 2; s++) {
        for (let i = 0; i < 6; i++) files[`f/d${d}/s${s}/n${i}.md`] = `note ${d} ${s} ${i}\n`;
        for (let i = 0; i < 2; i++) files[`f/d${d}/s${s}/img/p${i}.png`] = Buffer.from([d, s, i]);
      }
    }
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rp = tmpRoot('p');
    seed(ra, files);
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, [], {}, noHold));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa], {}, noHold));
    const P = track(await startNode(rp, 'pppp', pa + 2, [pa, pa + 1], {}, noHold));
    for (const n of [A, B, P]) folderEventsOnMkdir(n);
    await until(() => [B, P].every((n) => n.vault.exists('f/d3/s1/img/p1.png') && n.vault.text('f/d3/s1/n5.md') === 'note 3 1 5\n'), 20000);
    await sleep(1500);
    expect(listing(rp)).toEqual(listing(ra));

    // P is a phone: taking in each of its own deletions (saved history,
    // records) takes longer than Obsidian deleting the file, so they queue
    // up behind the folder's deletion.
    const local = (P.coord as any)._handleLocalFileChange.bind(P.coord);
    (P.coord as any)._handleLocalFileChange = async (event: any) => {
      if (event.type === 'delete') await sleep(60);
      return local(event);
    };
    const remade: string[] = [];
    const trigger = P.vault.trigger.bind(P.vault);
    P.vault.trigger = (ev: string, ...a: any[]) => {
      if (ev === 'create' && a[0]?.path?.startsWith('f/')) remade.push(a[0].path);
      return trigger(ev, ...a);
    };
    // Obsidian on a phone deletes a folder item by item, each with its event.
    const deleteFolder = async (p: string): Promise<void> => {
      for (const c of P.vault.folder(p)!.children) {
        await sleep(10);
        if (c instanceof TFolder) await deleteFolder(c.path);
        else await P.vault.deleteFile(c as any);
      }
      fs.rmdirSync(path.join(rp, p));
      P.vault.trigger('delete', new TFolder(p));
    };
    // File lists are exchanged every so often, here while P's deletions
    // still wait their turn.
    const rounds = setInterval(() => {
      for (const n of [A, B, P]) void (n.coord as any)._periodicFullSync();
    }, 1000);
    try {
      await deleteFolder('f');
      await until(() => [A, B, P].every((n) => !n.vault.exists('f')), 30000);
      await sleep(2000);
    } finally {
      clearInterval(rounds);
    }
    // Was: the files P had deleted but not yet recorded were fetched back
    // and sent back to it, with their folders, which then stayed, empty,
    // on every device.
    expect(remade).toEqual([]);
    for (const r of [ra, rb, rp]) expect(listing(r)).toEqual(['other.md']);
  });

  it('does not take a folder made for a peer\'s file for a new folder of its own', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    folderEventsOnMkdir(B);
    const sent = sentFolderCreates(B);
    await sleep(1000);
    await A.vault.writeBin('new/sub/x.png', new Uint8Array([1]));
    await A.vault.write('new/other/n.md', 'n\n');
    await until(() => B.vault.exists('new/sub/x.png') && B.vault.text('new/other/n.md') === 'n\n');
    await sleep(500);
    expect(B.vault.exists('new/sub/x.png')).toBe(true);
    // Was: each was sent to every peer as a folder made on B, and cleared
    // any record of its deletion there.
    expect(sent).toEqual([]);
  });
});

/** Count calls to a vault's adapter: on a phone, each is a round trip to the file system. */
function countAdapterCalls(n: Node) {
  const calls = new Map<string, number>();
  const adapter = n.vault.adapter;
  for (const name of Object.keys(adapter)) {
    const fn = adapter[name];
    if (typeof fn !== 'function') continue;
    adapter[name] = (...args: any[]) => {
      calls.set(name, (calls.get(name) ?? 0) + 1);
      return fn(...args);
    };
  }
  return { calls, total: () => [...calls.values()].reduce((a, b) => a + b, 0) };
}

describe('e2e file system work per file in bulk changes', { timeout: 60000 }, () => {
  const bulk = () => {
    const files: Record<string, string | Buffer> = {};
    for (let i = 0; i < 60; i++) files[`bulk/n${i}.md`] = `note ${i}\n`;
    for (let i = 0; i < 20; i++) files[`bulk/img/p${i}.png`] = Buffer.from([i, 1, 2]);
    return files;
  };

  it('deletes a peer\'s deleted files, with their backups, in a few calls per file', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, bulk());
    seed(rb, bulk());
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa], {}, noHold));
    await sleep(1500);
    const counter = countAdapterCalls(B);
    await A.vault.deleteFolder('bulk');
    await until(() => !B.vault.exists('bulk'), 15000);
    await sleep(1500);
    expect(B.vault.exists('bulk')).toBe(false);
    // Each file is backed up first (a read, its folders, the copy and its
    // details). The records of deletions are written once, not per file.
    // Was 1365 calls (803 lookups) and the same single write.
    expect(counter.calls.get('exists') ?? 0).toBeLessThan(10);
    expect(counter.total()).toBeLessThan(80 * 8);
    expect(fs.readdirSync(path.join(rb, '.obsidian/plugins/lan-vault-sync/conflicts'))).toHaveLength(80);
  });

  it('takes in a peer\'s new files in a few calls per file', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1000);
    const counter = countAdapterCalls(B);
    for (const [p, c] of Object.entries(bulk())) {
      if (typeof c === 'string') await A.vault.write(p, c);
      else await A.vault.writeBin(p, c);
    }
    await until(() => B.vault.exists('bulk/img/p19.png') && B.vault.text('bulk/n59.md') === 'note 59\n', 15000);
    await sleep(1500);
    // A saved history per note, and a look at its folder (the files
    // themselves are written through the vault). Was 341 calls.
    expect(counter.total()).toBeLessThan(80 * 2.5);
  });

  it('does not send a slow peer the files it is still taking in again at every round', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(1000);
    // B takes 30 ms per message, like a phone taking in a bulk change.
    const received = new Map<number, number>();
    const handle = (B.coord as any)._handleMessage.bind(B.coord);
    (B.coord as any)._handleMessage = async (from: string, type: number, payload: Uint8Array) => {
      received.set(type, (received.get(type) ?? 0) + 1);
      await sleep(30);
      return handle(from, type, payload);
    };
    for (let i = 0; i < 30; i++) await A.vault.write(`n${i}.md`, `note ${i}\n`);
    for (let i = 0; i < 10; i++) await A.vault.writeBin(`p${i}.png`, new Uint8Array([i]));
    // B lists its files three times while they are still on their way.
    for (let round = 0; round < 3; round++) {
      await (B.coord as any)._periodicFullSync();
      await sleep(150);
    }
    await until(() => B.vault.exists('p9.png') && B.vault.text('n29.md') === 'note 29\n', 20000);
    await sleep(500);
    expect(B.vault.text('n29.md')).toBe('note 29\n');
    // Each file comes once as it is made and at most once more for a list.
    expect(received.get(MessageType.YJS_FULL_STATE) ?? 0).toBeLessThanOrEqual(30);
    expect(received.get(MessageType.FILE_DATA) ?? 0).toBeLessThanOrEqual(20);
  });
});
