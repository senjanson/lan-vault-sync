import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthMonitor, alertText, vaultDigest, type Alert } from '../../src/diagnostics/health';
import { EventLog } from '../../src/diagnostics/event-log';
import { buildDiagnostics, maskSettings } from '../../src/diagnostics/export';
import { DEFAULT_SETTINGS } from '../../src/types';
import { MemoryAdapter } from './memory-adapter';

const MIN = 60 * 1000;

describe('HealthMonitor', () => {
  it('raises an alert for a file that differs at three exchanges in a row, and clears it once it matches', () => {
    let now = 1_000_000;
    const h = new HealthMonitor({ now: () => now, stuckMs: 2 * MIN });
    const notices: Alert[] = [];
    h.onAlert((a) => notices.push(a));
    h.noteExchange('B', { name: 'Phone', differing: ['a.md'] });
    expect(h.peers()[0]).toMatchObject({ differing: 1, unsynced: [] });
    h.noteExchange('B', { name: 'Phone', differing: ['a.md'] });
    expect(h.summary(['B'])).toMatchObject({ unsynced: 1, consistent: 0 });
    expect(h.alerts()).toEqual([]);
    h.noteExchange('B', { name: 'Phone', differing: ['a.md'] });
    // Three exchanges, but not yet long enough (a large file on its way).
    expect(h.alerts()).toEqual([]);
    now += 2 * MIN;
    h.noteExchange('B', { name: 'Phone', differing: ['a.md'] });
    expect(h.alerts().map((a) => a.kind)).toEqual(['file-mismatch']);
    expect(notices).toHaveLength(1);
    now += MIN;
    h.noteExchange('B', { name: 'Phone', differing: [] });
    expect(h.alerts()).toEqual([]);
    expect(h.summary(['B'])).toEqual({ consistent: 1, since: now, unsynced: 0 });
  });

  it('shows the same kind of alert as a notice at most once per 10 minutes, and counts the rest', () => {
    let now = 0;
    const h = new HealthMonitor({ now: () => now });
    const notices: Alert[] = [];
    h.onAlert((a) => notices.push(a));
    h.alert('write-failed', 'x');
    now += 5 * MIN;
    h.alert('write-failed', 'y');
    expect(notices).toHaveLength(1);
    expect(h.alerts()[0]).toMatchObject({ kind: 'write-failed', count: 2, msg: 'y' });
    now += 6 * MIN;
    h.alert('write-failed', 'z');
    expect(notices).toHaveLength(2);
    h.dismiss(h.alerts()[0].key);
    expect(h.alerts()).toEqual([]);
  });

  it('turns log records into alerts: a kept version that failed, a write that failed, a shrink', () => {
    const h = new HealthMonitor();
    const log = new EventLog(null);
    h.watch(log);
    log.record({ op: 'error', level: 'error', path: 'a.md', msg: 'live-delete: could not keep the old version; nothing was changed' });
    log.record({ op: 'error', level: 'error', path: 'b.md', error: 'EACCES' });
    log.record({ op: 'alert', level: 'warn', path: 'c.md', rule: 'content-shrank', msg: 'emptied' });
    expect(h.alerts().map((a) => a.kind).sort()).toEqual(['content-shrank', 'keep-failed', 'write-failed']);
  });

  it('warns about a clock more than 30 s off', () => {
    const h = new HealthMonitor();
    h.noteExchange('B', { differing: [], clockOffsetMs: 45_000 });
    expect(h.alerts()[0]).toMatchObject({ kind: 'clock-skew' });
    h.noteExchange('B', { differing: [], clockOffsetMs: 2_000 });
    expect(h.alerts()).toEqual([]);
  });

  it('digests a file list the same whatever its order', () => {
    const a = [{ path: 'a', hash: '1' }, { path: 'b', hash: '2' }];
    expect(vaultDigest(a)).toBe(vaultDigest([...a].reverse()));
    expect(vaultDigest(a)).not.toBe(vaultDigest([{ path: 'a', hash: '1' }, { path: 'b', hash: '3' }]));
  });
});

describe('diagnostics export', () => {
  it('T14: masks the sync key in the settings, the log and pairing links', () => {
    const key = 'ABCD-EFGH-IJKL-MNOP-QRST';
    const settings = { ...DEFAULT_SETTINGS, syncKey: key, deviceId: 'dev1' };
    const text = buildDiagnostics({
      pluginVersion: '0.5.0',
      platform: 'linux',
      settings,
      state: 'watching',
      peers: [],
      health: [],
      alerts: [],
      held: [],
      log: [
        { ts: 1, seq: 1, level: 'warn', op: 'log', msg: `bad key ${key}` },
        { ts: 2, seq: 2, level: 'info', op: 'log', msg: 'obsidian://lan-vault-sync?address=1.2.3.4:5&key=ABCDEFGHIJKLMNOPQRST' },
      ],
    });
    expect(text).not.toContain(key);
    expect(text).not.toContain('ABCDEFGHIJKLMNOPQRST');
    expect(text).not.toContain('IJKL');
    const data = JSON.parse(text);
    expect(data.settings.syncKey).toBe('****');
    expect(data.settings.deviceId).toBe('dev1');
    expect(data.rules['own-tombstone-skip']).toBeTruthy();
    expect(maskSettings({ ...settings, syncKey: '' }).syncKey).toBe('');
  });
});

describe('alert text', () => {
  it('names the device and the files in the user\'s language, with no English left in Chinese', async () => {
    const { alertText, peerName } = await import('../../src/diagnostics/health');
    const { setLanguage } = await import('../../src/i18n');
    const h = new HealthMonitor({ stuckMs: 0 });
    for (let i = 0; i < 3; i++) h.noteExchange('dev1', { name: 'dev1 (Phone)', differing: ['a.md'], clockOffsetMs: -45000 });
    const alerts = h.alerts();
    const mismatch = alerts.find((a) => a.kind === 'file-mismatch')!;
    const skew = alerts.find((a) => a.kind === 'clock-skew')!;
    try {
      setLanguage('zh');
      expect(alertText(mismatch)).toBe('LAN Vault Sync：有 1 个文件与 Phone 仍不一致：a.md。详情见同步面板。');
      expect(alertText(skew)).toContain('Phone 的时钟比本设备慢 45 秒');
      setLanguage('en');
      expect(alertText(skew)).toContain("Phone's clock is 45 s behind");
    } finally {
      setLanguage(null);
    }
    expect(peerName('kg9t76s8s5nhzkj5 (v2)')).toBe('v2');
    expect(peerName(undefined)).toBe('?');
  });
});

describe('alerts that go away with their problem', () => {
  it('clears a held-deletion alert once its batch no longer waits', () => {
    const h = new HealthMonitor();
    const log = new EventLog(null);
    h.watch(log);
    log.record({ op: 'held', level: 'warn', path: 'a.md', peer: 'mac (Mac)', batch: 'b1', rule: 'bulk-delete' });
    log.record({ op: 'held', level: 'warn', peer: 'mac (Mac)', batch: 'b2', rule: 'deleted-while-stopped' });
    expect(h.alerts().filter((a) => a.kind === 'bulk-held')).toHaveLength(2);
    h.keepHeld(['b2']);
    expect(h.alerts().map((a) => a.key)).toEqual(['bulk-held\nb2']);
    h.keepHeld([]);
    expect(h.alerts()).toEqual([]);
  });

  it('clears a failed keep or write for a path once a later step on it succeeds', () => {
    const h = new HealthMonitor();
    const log = new EventLog(null);
    h.watch(log);
    log.record({ op: 'error', level: 'error', path: 'a.png', msg: 'remote-file-delete: could not keep the old version; nothing was changed' });
    log.record({ op: 'error', level: 'error', path: 'b.png', msg: 'remote-file-delete: could not keep the old version; nothing was changed' });
    log.record({ op: 'error', level: 'error', path: 'c.png', error: 'EACCES', msg: 'write failed' });
    expect(h.alerts()).toHaveLength(3);
    // The version store is writable again and the deletion went ahead.
    log.record({ op: 'delete', path: 'a.png', peer: 'mac (Mac)', rule: 'tombstone-covers' });
    expect(h.alerts().map((a) => a.path).sort()).toEqual(['b.png', 'c.png']);
    // A skip or a failed precondition is no success.
    log.record({ op: 'precondition-failed', level: 'warn', path: 'b.png' });
    expect(h.alerts()).toHaveLength(2);
    log.record({ op: 'overwrite', path: 'b.png' });
    expect(h.alerts().map((a) => a.path)).toEqual(['c.png']);
  });

  it('clears a failed keep or write once the file is gone, and a failed write once the file is written', () => {
    const h = new HealthMonitor();
    const log = new EventLog(null);
    h.watch(log);
    log.record({ op: 'error', level: 'error', path: 'a.png', msg: 'remote-file-delete: could not keep the old version; nothing was changed' });
    log.record({ op: 'error', level: 'error', path: 'b.png', error: 'EACCES', msg: 'write failed' });
    log.record({ op: 'error', level: 'error', path: 'c.png', error: 'EACCES', msg: 'write failed' });
    h.notePathWritten('a.png');
    // A write to the file says nothing about the version store.
    expect(h.alerts()).toHaveLength(3);
    h.notePathGone('a.png');
    h.notePathWritten('b.png');
    expect(h.alerts().map((a) => a.path)).toEqual(['c.png']);
  });

  it('keeps an event alert like a shrink until it is dismissed', () => {
    const h = new HealthMonitor();
    const log = new EventLog(null);
    h.watch(log);
    log.record({ op: 'alert', level: 'warn', path: 'c.md', rule: 'content-shrank', msg: 'emptied' });
    log.record({ op: 'overwrite', path: 'c.md' });
    h.notePathGone('c.md');
    h.keepHeld([]);
    expect(h.alerts().map((a) => a.kind)).toEqual(['content-shrank']);
  });
});

describe('emptied note alert', () => {
  it('names the device whose change emptied the note, when the record has it', () => {
    const h = new HealthMonitor();
    const log = new EventLog(null);
    h.watch(log);
    log.record({ op: 'alert', level: 'warn', path: 'c.md', peer: 'aaaa (macA)', rule: 'content-shrank', msg: 'emptied' });
    expect(alertText(h.alerts()[0])).toContain('macA');
    const h2 = new HealthMonitor();
    const log2 = new EventLog(null);
    h2.watch(log2);
    log2.record({ op: 'alert', level: 'warn', path: 'd.md', rule: 'content-shrank', msg: 'emptied' });
    expect(alertText(h2.alerts()[0])).toContain('another device');
  });
});

describe('devices that are gone', () => {
  it('shows a disconnected device as disconnected, drops what was compared after a while, and forgets it after 30 days', () => {
    let now = 0;
    const h = new HealthMonitor({ now: () => now, stuckMs: 0 });
    const log = new EventLog(null, { now: () => now });
    h.watch(log);
    log.record({ op: 'connect', peer: 'macb (macB)' });
    h.noteExchange('macb', { name: 'macb (macB)', differing: [] });
    now += MIN;
    for (let i = 0; i < 3; i++) h.noteExchange('macb', { name: 'macb (macB)', differing: ['a.md'], clockOffsetMs: 60_000 });
    expect(h.peers()[0]).toMatchObject({ id: 'macb', connected: true, unsynced: ['a.md'], lastConsistent: 0 });
    expect(h.alerts().map((a) => a.kind).sort()).toEqual(['clock-skew', 'file-mismatch']);
    log.record({ op: 'disconnect', peer: 'macb' });
    now += 10 * MIN;
    expect(h.peers()[0]).toMatchObject({ id: 'macb', connected: false });
    // Not counted while away.
    expect(h.summary(['other'])).toMatchObject({ unsynced: 0 });
    now += 25 * MIN;
    // Still listed, with when its files last all matched, but what was
    // compared with it, and the alerts about it, are gone.
    expect(h.peers()).toMatchObject([{ id: 'macb', connected: false, lastConsistent: 0, unsynced: [], differing: 0 }]);
    expect(h.alerts()).toEqual([]);
    now += 30 * 24 * 60 * MIN;
    expect(h.peers()).toEqual([]);
  });

  it('keeps a device that comes back before then', () => {
    let now = 0;
    const h = new HealthMonitor({ now: () => now, forgetPeerAfterMs: 30 * MIN });
    const log = new EventLog(null, { now: () => now });
    h.watch(log);
    log.record({ op: 'connect', peer: 'pixel (Pixel)' });
    h.noteExchange('pixel', { name: 'pixel (Pixel)', differing: [] });
    log.record({ op: 'disconnect', peer: 'pixel (Pixel)' });
    now += 20 * MIN;
    log.record({ op: 'connect', peer: 'pixel (Pixel)' });
    now += 20 * MIN;
    expect(h.peers()).toMatchObject([{ id: 'pixel', connected: true }]);
  });

  it('drops a device at once when the same device comes back under a new ID', () => {
    let now = 0;
    const h = new HealthMonitor({ now: () => now, stuckMs: 0 });
    const log = new EventLog(null, { now: () => now });
    h.watch(log);
    for (let i = 0; i < 4; i++) h.noteExchange('5wpgwawbf5wpwhws', { name: '5wpgwawbf5wpwhws (macB)', differing: ['a.md'] });
    expect(h.alerts().length).toBeGreaterThan(0);
    log.record({ op: 'disconnect', peer: '5wpgwawbf5wpwhws' });
    log.record({ op: 'connect', peer: 'kg9t76s8s5nhzkj5 (macB)' });
    expect(h.peers().map((p) => p.id)).toEqual(['kg9t76s8s5nhzkj5']);
    expect(h.alerts().filter((a) => a.kind === 'file-mismatch')).toEqual([]);
  });

  it('does not drop another connected device that happens to share the name', () => {
    const h = new HealthMonitor();
    const log = new EventLog(null);
    h.watch(log);
    log.record({ op: 'connect', peer: 'aaaa (Phone)' });
    log.record({ op: 'connect', peer: 'bbbb (Phone)' });
    expect(h.peers().map((p) => p.id).sort()).toEqual(['aaaa', 'bbbb']);
  });
});

describe('files too large for one side', () => {
  const file = (path: string, size: number, isTextFile = false) => ({ path, size, isTextFile, hash: path + size, mtime: 0 });
  it('picks the files a receive limit keeps apart, on either side', () => {
    const diff = {
      localOnly: [file('big-here.bin', 300), file('small.bin', 10), file('huge.md', 300, true)],
      remoteOnly: [file('big-there.bin', 300), file('small2.bin', 10)],
      conflicting: [{ local: file('c.bin', 10), remote: file('c.bin', 300) }],
    };
    // This device takes up to 200; the peer up to 100.
    expect(HealthMonitor.tooLargeToSync(diff, 200, 100)).toEqual({ here: ['big-there.bin', 'c.bin'], there: ['big-here.bin'] });
    expect(HealthMonitor.tooLargeToSync(diff, 0, 0)).toEqual({ here: [], there: [] });
  });

  it('lists such files apart and does not count them as out of sync', () => {
    const h = new HealthMonitor({ stuckMs: 0 });
    for (let i = 0; i < 4; i++) {
      h.noteExchange('pixel', { name: 'pixel (Pixel)', differing: ['big.bin', 'out.bin'], tooLarge: { here: ['big.bin'], there: ['out.bin'] } });
    }
    expect(h.peers()[0]).toMatchObject({ differing: 0, unsynced: [], tooLargeHere: ['big.bin'], tooLargeThere: ['out.bin'] });
    expect(h.summary(['pixel'])).toMatchObject({ consistent: 1, unsynced: 0 });
    expect(h.alerts()).toEqual([]);
  });

  it('takes the too-large alert down once the device that has the file no longer lists it', () => {
    const log = new EventLog(null);
    const h = new HealthMonitor({ stuckMs: 0 });
    h.watch(log);
    log.record({ op: 'skip', level: 'warn', path: 'big/b.bin', peer: 'pixel (Pixel)', rule: 'too-large', msg: 'too large' });
    expect(h.alerts().map((a) => [a.kind, a.path])).toEqual([['too-large', 'big/b.bin']]);
    // Still on the sender, still too large: the alert stays.
    h.noteExchange('pixel', { name: 'pixel (Pixel)', differing: ['big/b.bin'], tooLarge: { here: ['big/b.bin'] } });
    expect(h.alerts().map((a) => a.kind)).toEqual(['too-large']);
    // Another device that does not have the file says nothing about it.
    h.noteExchange('mac', { name: 'mac (Mac)', differing: [] });
    expect(h.alerts().map((a) => a.kind)).toEqual(['too-large']);
    // The sender deleted it: nothing is left to receive.
    h.noteExchange('pixel', { name: 'pixel (Pixel)', differing: [] });
    expect(h.alerts()).toEqual([]);
  });
});

describe('the folder a connection is limited to', () => {
  it('lists the folder with the device, and raises and clears alerts for folders that do not overlap or are missing', async () => {
    const { setLanguage } = await import('../../src/i18n');
    const h = new HealthMonitor();
    const notices: Alert[] = [];
    h.onAlert((a) => notices.push(a));
    h.notePeerConnected('mac', 'Work Mac');
    h.notePeerScope('mac', { only: 'Work' });
    expect(h.peers()[0].only).toBe('Work');
    expect(h.alerts()).toEqual([]);

    h.notePeerScope('mac', { disjoint: { here: 'Home', there: 'Work' } });
    expect(h.peers()[0].only).toBeUndefined();
    // Said again on the next connection: one alert, one notice.
    h.notePeerScope('mac', { disjoint: { here: 'Home', there: 'Work' } });
    expect(h.alerts().map((a) => a.kind)).toEqual(['scope-disjoint']);
    expect(notices).toHaveLength(1);
    try {
      setLanguage('en');
      expect(alertText(h.alerts()[0])).toContain('This device syncs the folder “Home” and Work Mac syncs the folder “Work”');
      h.notePeerScope('mac', { disjoint: { here: '', there: '../bad' } });
      expect(alertText(h.alerts()[0])).toContain('This device syncs the whole vault and Work Mac syncs the folder “../bad”');
      setLanguage('zh');
      expect(alertText(h.alerts()[0])).toContain('本设备同步整个库，Work Mac 同步“../bad”文件夹');
    } finally {
      setLanguage(null);
    }

    h.notePeerScope('mac', { only: 'Work', missingHere: 'Work' });
    expect(h.alerts().map((a) => a.kind)).toEqual(['scope-missing']);
    try {
      setLanguage('zh');
      expect(alertText(h.alerts()[0])).toContain('Work Mac 只同步“Work”文件夹，但本库里没有这个名字的文件夹');
    } finally {
      setLanguage(null);
    }
    // State alerts: they stay until the state goes, not for a day.
    h.notePeerScope('mac', { only: 'Work' });
    expect(h.alerts()).toEqual([]);

    h.notePeerScope('mac', { disjoint: { here: 'A', there: 'B' }, missingHere: 'B' });
    expect(h.alerts()).toHaveLength(2);
    h.forgetPeer('mac');
    expect(h.alerts()).toEqual([]);
  });
});

describe('devices kept across restarts', () => {
  afterEach(() => vi.useRealTimers());
  const DAY = 24 * 60 * MIN;

  it('saves each device and reads it back as disconnected, with when its files last all matched', async () => {
    const adapter = new MemoryAdapter();
    let now = 1_000_000;
    const h = new HealthMonitor({ now: () => now });
    await h.attachPeerStore(adapter);
    h.notePeerConnected('pixel', 'Pixel');
    h.noteExchange('pixel', { name: 'pixel (Pixel)', differing: [] });
    const synced = now;
    now += MIN;
    h.noteExchange('pixel', { name: 'pixel (Pixel)', differing: ['a.md'] });
    await h.flushPeers();
    expect(adapter.folders.has('.lan-vault-sync')).toBe(true);
    const saved = JSON.parse(adapter.files.get('.lan-vault-sync/peers.json') as string);
    expect(saved).toEqual({ version: 1, peers: { pixel: { name: 'pixel (Pixel)', lastConsistent: synced, lastSeen: now } } });

    // Restarted a day later.
    now += DAY;
    const h2 = new HealthMonitor({ now: () => now });
    await h2.attachPeerStore(adapter);
    expect(h2.peers()).toMatchObject([{ id: 'pixel', name: 'pixel (Pixel)', connected: false, lastConsistent: synced, differing: 0, unsynced: [] }]);
    expect(h2.summary(['pixel'])).toMatchObject({ consistent: 0, unsynced: 0 });
    expect(h2.alerts()).toEqual([]);
    // Forgotten 30 days after it was last seen, and so in the file too.
    now += 30 * DAY;
    expect(h2.peers()).toEqual([]);
    await h2.flushPeers();
    expect(JSON.parse(adapter.files.get('.lan-vault-sync/peers.json') as string).peers).toEqual({});
  });

  it('keeps what is newer here when a device connected while the file was read', async () => {
    const adapter = new MemoryAdapter();
    adapter.files.set('.lan-vault-sync/peers.json', JSON.stringify({
      version: 1,
      peers: {
        pixel: { name: 'pixel (Pixel)', lastConsistent: 500, lastSeen: 600 },
        old: { name: 'old (Mac)', lastConsistent: 100, lastSeen: 200 },
      },
    }));
    const now = 1000;
    const h = new HealthMonitor({ now: () => now });
    h.notePeerConnected('pixel', 'Pixel');
    // The same Mac under a new ID: the old one will not come back.
    h.notePeerConnected('new', 'Mac');
    h.noteExchange('pixel', { name: 'pixel (Pixel)', differing: ['x.md'] });
    await h.attachPeerStore(adapter);
    const peers = h.peers();
    expect(peers.map((p) => p.id).sort()).toEqual(['new', 'pixel']);
    expect(peers.find((p) => p.id === 'pixel')).toMatchObject({ connected: true, lastConsistent: 500, lastSeen: 1000, differing: 1 });
    await h.flushPeers();
    const saved = JSON.parse(adapter.files.get('.lan-vault-sync/peers.json') as string);
    expect(Object.keys(saved.peers).sort()).toEqual(['new', 'pixel']);
  });

  it('forgets a saved device at once when the same device connects under a new ID', async () => {
    const adapter = new MemoryAdapter();
    adapter.files.set('.lan-vault-sync/peers.json', JSON.stringify({ version: 1, peers: { old: { name: 'old (Mac)', lastSeen: 900 } } }));
    const h = new HealthMonitor({ now: () => 1000 });
    await h.attachPeerStore(adapter);
    expect(h.peers()).toMatchObject([{ id: 'old', connected: false }]);
    expect(h.peers()[0].lastConsistent).toBeUndefined();
    h.notePeerConnected('new', 'Mac');
    expect(h.peers().map((p) => p.id)).toEqual(['new']);
  });

  it('ignores a damaged file, an adapter that cannot read or write, and none at all', async () => {
    const adapter = new MemoryAdapter();
    adapter.files.set('.lan-vault-sync/peers.json', '{not json');
    const h = new HealthMonitor();
    await expect(h.attachPeerStore(adapter)).resolves.toBeUndefined();
    expect(h.peers()).toEqual([]);
    adapter.files.set('.lan-vault-sync/peers.json', JSON.stringify({ version: 1, peers: { a: 'x', b: { lastSeen: 'soon' }, '': {} } }));
    const h2 = new HealthMonitor();
    await h2.attachPeerStore(adapter);
    expect(h2.peers()).toEqual([]);
    for (const bad of [null, undefined, {}, { exists: async () => false }]) {
      const h3 = new HealthMonitor();
      await expect(h3.attachPeerStore(bad)).resolves.toBeUndefined();
      h3.notePeerConnected('a', 'A');
      await expect(h3.flushPeers()).resolves.toBeUndefined();
    }
    // A failed save is tried again with the next one.
    const failing = new MemoryAdapter();
    const h4 = new HealthMonitor();
    await h4.attachPeerStore(failing);
    failing.failWrites = true;
    h4.notePeerConnected('a', 'A');
    await expect(h4.flushPeers()).resolves.toBeUndefined();
    failing.failWrites = false;
    await h4.flushPeers();
    expect(failing.files.has('.lan-vault-sync/peers.json')).toBe(true);
  });

  it('saves a few seconds after a device comes or goes, and times moved by exchanges at most once a minute', async () => {
    vi.useFakeTimers();
    const adapter = new MemoryAdapter();
    const writes: string[] = [];
    const write = adapter.write.bind(adapter);
    adapter.write = async (p: string, d: string) => {
      if (p.startsWith('.lan-vault-sync/peers.json')) writes.push(d);
      return write(p, d);
    };
    const h = new HealthMonitor();
    await h.attachPeerStore(adapter);
    h.notePeerConnected('pixel', 'Pixel');
    h.noteExchange('pixel', { name: 'pixel (Pixel)', differing: [] });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).toHaveLength(1);
    // An exchange every 10 s moves the times: saved once a minute, not each time.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      h.noteExchange('pixel', { name: 'pixel (Pixel)', differing: [] });
    }
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(2);
    // Leaving is saved soon, and flushPeers saves at once.
    h.notePeerDisconnected('pixel');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(writes).toHaveLength(3);
    // Nothing that is kept changed: nothing written.
    h.noteWaiting('pixel', 3);
    await h.flushPeers();
    expect(writes).toHaveLength(3);
    h.notePeerConnected('pixel', 'Pixel');
    await h.flushPeers();
    expect(writes).toHaveLength(4);
  });
});
