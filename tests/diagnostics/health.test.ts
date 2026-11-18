import { describe, expect, it } from 'vitest';
import { HealthMonitor, vaultDigest, type Alert } from '../../src/diagnostics/health';
import { EventLog } from '../../src/diagnostics/event-log';
import { buildDiagnostics, maskSettings } from '../../src/diagnostics/export';
import { DEFAULT_SETTINGS } from '../../src/types';

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
