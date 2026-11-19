/**
 * End-to-end scenarios for a device that syncs only one folder of the vault
 * (settings.syncFolder): what reaches it, what it sends, moves across the
 * folder's edge, older peers, and changing the setting (see harness.ts for
 * the test vaults).
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
import { encodeFileDelete, encodeFileMetaSync, encodeFileRename, encodeFileRequest } from '../../src/transport/protocol';
import { connectRaw, Node, ports, seed, sleep, startNode, tmpRoot, until } from './harness';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

/** Every file under a vault root, outside the plugin's hidden folders. */
function listFiles(root: string, dir = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Every folder under a vault root, outside the plugin's hidden folders. */
function listFolders(root: string, dir = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    out.push(rel, ...listFolders(root, rel));
  }
  return out.sort();
}

/** Run a few file list exchanges both ways, so that both sides have settled. */
async function settle(...ns: Node[]) {
  for (let round = 0; round < 3; round++) {
    for (const n of ns) await (n.coord as any)._periodicFullSync();
    await sleep(300);
  }
}

const homeFiles = {
  'Work/a.md': 'work a\n',
  'Work/sub/b.md': 'work b\n',
  'Work/img.png': Buffer.from([1, 2, 3, 4]),
  'Personal/secret.md': 'my secret plan\n',
  'Personal/photo.png': Buffer.from([9, 9, 9]),
  'Workshop/tools.md': 'not work\n',
  'top.md': 'top level\n',
};

describe('e2e syncing one folder', { timeout: 60000 }, () => {
  it('sends a device that syncs one folder only that folder, and no names outside it', async () => {
    const ra = tmpRoot('a'), rc = tmpRoot('c');
    seed(ra, homeFiles);
    fs.mkdirSync(path.join(ra, 'Work/empty'), { recursive: true });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const C = track(await startNode(rc, 'cccc', pa + 1, [pa], { syncFolder: 'Work' }));
    await until(() => C.vault.text('Work/sub/b.md') === 'work b\n' && C.vault.exists('Work/img.png') && C.vault.exists('Work/empty'));
    await settle(A, C);
    expect(listFiles(rc)).toEqual(['Work/a.md', 'Work/img.png', 'Work/sub/b.md']);
    expect(listFolders(rc)).toEqual(['Work', 'Work/empty', 'Work/sub']);
    expect([...C.vault.bin('Work/img.png')!]).toEqual([1, 2, 3, 4]);

    // A raw device that says it syncs Work sees every message A sends it.
    const vaultId = (A.coord as any).vaultId;
    const peer = await connectRaw(pa, { deviceId: 'raw-work', deviceName: 'raw', vaultId, syncFolder: 'Work' }, 'TEST-KEY');
    await until(() => A.coord.getConnectedDevices().includes('raw-work'));
    // It lacks everything and asks for files outside the folder too, and
    // lists a deletion and a rename outside it.
    peer.send(encodeFileMetaSync({
      files: [],
      folders: [],
      deleted: [{ path: 'Personal/secret.md', deletedAt: Date.now() }],
    }));
    peer.send(encodeFileRequest('Personal/photo.png'));
    peer.send(encodeFileRequest('top.md'));
    peer.send(encodeFileDelete({ path: 'top.md', deletedAt: Date.now() }));
    peer.send(encodeFileRename({ oldPath: 'Personal/secret.md', newPath: 'Personal/x.md' }));
    // Changes outside the folder while it is connected.
    await A.vault.write('Personal/secret.md', 'my secret plan, edited\n');
    await A.vault.write('Personal/new-secret.md', 'another secret\n');
    await A.vault.mv('Workshop/tools.md', 'Workshop/tools2.md');
    await A.vault.rm('Personal/photo.png');
    await sleep(1500);
    await (A.coord as any)._periodicFullSync();
    await sleep(800);

    const all = Buffer.concat(peer.received.map((m) => Buffer.from(m.payload)));
    expect(peer.received.length).toBeGreaterThan(0);
    expect(all.includes(Buffer.from('Work/a.md'))).toBe(true);
    for (const name of ['Personal', 'secret', 'photo', 'Workshop', 'tools', 'top.md']) {
      expect(all.includes(Buffer.from(name)), name).toBe(false);
    }
    // Nothing it sent outside the folder was taken.
    expect(A.vault.text('Personal/secret.md')).toBe('my secret plan, edited\n');
    expect(A.vault.text('top.md')).toBe('top level\n');
    expect(A.vault.exists('Personal/x.md')).toBe(false);
    peer.ws.close();
  });

  it('sends back changes made in the folder, and nothing outside it', async () => {
    const ra = tmpRoot('a'), rc = tmpRoot('c');
    seed(ra, homeFiles);
    seed(rc, { 'Private/local.md': 'company only\n', 'Personal/secret.md': 'company copy\n', 'top.md': 'company top\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const C = track(await startNode(rc, 'cccc', pa + 1, [pa], { syncFolder: 'Work' }));
    await until(() => C.vault.text('Work/a.md') === 'work a\n' && C.vault.exists('Work/sub/b.md'));

    await C.vault.write('Work/new.md', 'made at work\n');
    await C.vault.write('Work/a.md', 'work a, edited at work\n');
    await C.vault.rm('Work/sub/b.md');
    await C.vault.write('Private/later.md', 'also company only\n');
    await until(() => A.vault.text('Work/new.md') === 'made at work\n'
      && A.vault.text('Work/a.md') === 'work a, edited at work\n'
      && !A.vault.exists('Work/sub/b.md'));
    await settle(A, C);

    expect(A.vault.text('Work/new.md')).toBe('made at work\n');
    expect(A.vault.text('Work/a.md')).toBe('work a, edited at work\n');
    expect(A.vault.exists('Work/sub/b.md')).toBe(false);
    // The company device's own files outside the folder stay there.
    expect(A.vault.exists('Private/local.md')).toBe(false);
    expect(A.vault.exists('Private/later.md')).toBe(false);
    expect(A.vault.text('Personal/secret.md')).toBe('my secret plan\n');
    expect(A.vault.text('top.md')).toBe('top level\n');
    expect(C.vault.text('Personal/secret.md')).toBe('company copy\n');
    expect(C.vault.text('top.md')).toBe('company top\n');
  });

  it('keeps changes outside the folder away from the device that syncs one folder', async () => {
    const ra = tmpRoot('a'), rc = tmpRoot('c');
    seed(ra, homeFiles);
    seed(rc, { 'Personal/secret.md': 'company copy\n', 'top.md': 'company top\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const C = track(await startNode(rc, 'cccc', pa + 1, [pa], { syncFolder: 'Work' }));
    await until(() => C.vault.text('Work/a.md') === 'work a\n');

    await A.vault.write('Personal/secret.md', 'edited at home\n');
    await A.vault.rm('top.md');
    await A.vault.mv('Personal/photo.png', 'Personal/photo2.png');
    await A.vault.write('Personal/new.md', 'new at home\n');
    await sleep(1000);
    await settle(A, C);

    expect(C.vault.text('Personal/secret.md')).toBe('company copy\n');
    expect(C.vault.text('top.md')).toBe('company top\n');
    expect(C.vault.exists('Personal/photo2.png')).toBe(false);
    expect(C.vault.exists('Personal/new.md')).toBe(false);
    expect(listFiles(rc)).toEqual(['Personal/secret.md', 'Work/a.md', 'Work/img.png', 'Work/sub/b.md', 'top.md']);
  });

  it('takes moves out of the folder as deletions and moves in as new files', async () => {
    const ra = tmpRoot('a'), rc = tmpRoot('c');
    seed(ra, { ...homeFiles, 'Work/c.md': 'work c\n', 'Personal/p.md': 'personal p\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const C = track(await startNode(rc, 'cccc', pa + 1, [pa], { syncFolder: 'Work' }));
    await until(() => C.vault.text('Work/a.md') === 'work a\n' && C.vault.text('Work/c.md') === 'work c\n');

    // Out of the folder at home: gone at work.
    await A.vault.mv('Work/a.md', 'Personal/a.md');
    await until(() => !C.vault.exists('Work/a.md'));
    expect(C.vault.exists('Work/a.md')).toBe(false);
    expect(C.vault.exists('Personal/a.md')).toBe(false);
    expect(A.vault.text('Personal/a.md')).toBe('work a\n');

    // Into the folder at home: new at work.
    await A.vault.mv('Personal/p.md', 'Work/p.md');
    await until(() => C.vault.text('Work/p.md') === 'personal p\n');
    expect(C.vault.text('Work/p.md')).toBe('personal p\n');

    // Out of the folder at work: gone at home, and its new place stays at work.
    await C.vault.mv('Work/c.md', 'Private/c.md');
    await until(() => !A.vault.exists('Work/c.md'));
    expect(A.vault.exists('Work/c.md')).toBe(false);
    expect(A.vault.exists('Private/c.md')).toBe(false);
    expect(C.vault.text('Private/c.md')).toBe('work c\n');

    await settle(A, C);
    expect(listFiles(rc)).toEqual(['Private/c.md', 'Work/img.png', 'Work/p.md', 'Work/sub/b.md']);
    expect(A.vault.text('Personal/a.md')).toBe('work a\n');
    expect(A.vault.text('Work/p.md')).toBe('personal p\n');
  });

  it('leaves two whole-vault devices syncing everything beside a device that syncs one folder', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b'), rc = tmpRoot('c');
    seed(ra, homeFiles);
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    const C = track(await startNode(rc, 'cccc', pa + 2, [pa], { syncFolder: 'Work' }));
    await until(() => B.vault.text('Personal/secret.md') === 'my secret plan\n' && C.vault.text('Work/a.md') === 'work a\n');

    await A.vault.write('Personal/z.md', 'from A\n');
    await B.vault.write('Work/w.md', 'from B\n');
    await C.vault.write('Work/c2.md', 'from C\n');
    await until(() => B.vault.text('Personal/z.md') === 'from A\n'
      && C.vault.text('Work/w.md') === 'from B\n'
      && B.vault.text('Work/c2.md') === 'from C\n');
    await settle(A, B, C);

    expect(listFiles(rb)).toEqual(listFiles(ra));
    expect(listFiles(ra)).toContain('Personal/z.md');
    expect(listFiles(rc)).toEqual(['Work/a.md', 'Work/c2.md', 'Work/img.png', 'Work/sub/b.md', 'Work/w.md']);
  });

  it('refuses an older device only where a folder is set', async () => {
    const ra = tmpRoot('a'), rc = tmpRoot('c');
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const C = track(await startNode(rc, 'cccc', pa + 1, [], { syncFolder: 'Work' }));
    const failures: string[] = [];
    C.coord.onAuthFailed((f) => failures.push(`${f.deviceName}:${f.reason}`));
    const vaultId = (A.coord as any).vaultId;

    // An older version sends no syncFolder at all.
    const oldToC = await connectRaw(pa + 1, { deviceId: 'old1', deviceName: 'old', vaultId }, 'TEST-KEY');
    await sleep(300);
    expect(oldToC.isClosed()).toBe(true);
    expect(failures).toEqual(['old:outdated']);
    expect(C.coord.getConnectedDevices()).toEqual([]);

    // A device without a folder still syncs with it.
    const oldToA = await connectRaw(pa, { deviceId: 'old2', deviceName: 'old', vaultId }, 'TEST-KEY');
    await until(() => A.coord.getConnectedDevices().includes('old2'));
    expect(oldToA.isClosed()).toBe(false);
    expect(A.coord.getConnectedDevices()).toContain('old2');

    // A current one is let in.
    const current = await connectRaw(pa + 1, { deviceId: 'new1', deviceName: 'new', vaultId, syncFolder: '' }, 'TEST-KEY');
    await until(() => C.coord.getConnectedDevices().includes('new1'));
    expect(current.isClosed()).toBe(false);
    oldToA.ws.close();
    current.ws.close();
  });

  it('shows both sides in sync', async () => {
    const ra = tmpRoot('a'), rc = tmpRoot('c');
    seed(ra, homeFiles);
    seed(rc, { 'Private/local.md': 'company only\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const C = track(await startNode(rc, 'cccc', pa + 1, [pa], { syncFolder: 'Work' }));
    await until(() => C.vault.exists('Work/sub/b.md') && C.vault.exists('Work/img.png'));
    await settle(A, C);

    const onA = A.coord.health.peers().find((p) => p.id === 'cccc')!;
    const onC = C.coord.health.peers().find((p) => p.id === 'aaaa')!;
    for (const p of [onA, onC]) {
      expect(p.digestMatch).toBe(true);
      expect(p.differing).toBe(0);
      expect(p.unsynced).toEqual([]);
      expect((p as any).only).toBe('Work');
    }
    expect(A.coord.health.alerts().filter((a) => a.kind === 'file-mismatch')).toEqual([]);
    expect(C.coord.health.alerts().filter((a) => a.kind === 'file-mismatch')).toEqual([]);
  });

  it('deletes nothing when the folder setting is cleared or set', async () => {
    const ra = tmpRoot('a'), rc = tmpRoot('c');
    seed(ra, homeFiles);
    seed(rc, { 'Private/local.md': 'company only\n' });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    let C = track(await startNode(rc, 'cccc', pa + 1, [pa], { syncFolder: 'Work' }));
    await until(() => C.vault.exists('Work/sub/b.md') && C.vault.exists('Work/img.png'));
    await settle(A, C);
    await C.coord.stop();
    nodes = nodes.filter((n) => n !== C);

    // Cleared: the whole vault arrives, and nothing is taken as deleted.
    C = track(await startNode(rc, 'cccc', pa + 1, [pa], { syncFolder: '' }));
    await until(() => C.vault.text('Personal/secret.md') === 'my secret plan\n' && A.vault.text('Private/local.md') === 'company only\n');
    await settle(A, C);
    const everything = ['Personal/photo.png', 'Personal/secret.md', 'Private/local.md', 'Work/a.md', 'Work/img.png', 'Work/sub/b.md', 'Workshop/tools.md', 'top.md'];
    expect(listFiles(ra)).toEqual(everything);
    expect(listFiles(rc)).toEqual(everything);
    expect(C.events.filter((e) => /deleted|held/i.test(e))).toEqual([]);
    expect(A.events.filter((e) => /deleted|held/i.test(e))).toEqual([]);
    await C.coord.stop();
    nodes = nodes.filter((n) => n !== C);

    // Set again: what lies outside the folder stays on both sides.
    C = track(await startNode(rc, 'cccc', pa + 1, [pa], { syncFolder: 'Work' }));
    await until(() => C.coord.getConnectedDevices().includes('aaaa'));
    await settle(A, C);
    expect(listFiles(ra)).toEqual(everything);
    expect(listFiles(rc)).toEqual(everything);
    expect(C.events.filter((e) => /deleted|held/i.test(e))).toEqual([]);
    expect(A.events.filter((e) => /deleted|held/i.test(e))).toEqual([]);

    // And a change outside the folder at home no longer reaches it.
    await A.vault.write('Personal/secret.md', 'edited at home\n');
    await A.vault.write('Work/a.md', 'work a, edited at home\n');
    await until(() => C.vault.text('Work/a.md') === 'work a, edited at home\n');
    await settle(A, C);
    expect(C.vault.text('Personal/secret.md')).toBe('my secret plan\n');
  });
});
