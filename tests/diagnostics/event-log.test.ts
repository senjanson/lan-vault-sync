import { afterEach, describe, expect, it } from 'vitest';
import { EventLog } from '../../src/diagnostics/event-log';
import { logger, setLogSink } from '../../src/logger';
import { MemoryAdapter } from './memory-adapter';

const DAY = 24 * 60 * 60 * 1000;

describe('EventLog', () => {
  afterEach(() => setLogSink(null));

  it('writes one JSON line per record into a day file, readable after a restart', async () => {
    const adapter = new MemoryAdapter();
    const now = new Date(2026, 10, 18, 12).getTime();
    const log = new EventLog(adapter, { now: () => now });
    log.record({ op: 'delete', path: 'a.md', peer: 'B (Phone)', rule: 'live-delete', before: { hash: 'h1', size: 3 } });
    log.record({ op: 'skip', path: 'b.md' });
    await log.flush();
    const file = '.lan-vault-sync/logs/sync-2026-11-18.jsonl';
    expect((await adapter.read(file)).trim().split('\n')).toHaveLength(2);

    const again = new EventLog(adapter, { now: () => now });
    const recs = await again.readAll();
    expect(recs[0]).toMatchObject({ op: 'delete', path: 'a.md', rule: 'live-delete', level: 'info', seq: 1, before: { hash: 'h1' } });
  });

  it('buffers lines and writes them together', async () => {
    const adapter = new MemoryAdapter();
    const log = new EventLog(adapter, { flushMs: 20 });
    for (let i = 0; i < 50; i++) log.record({ op: 'log', msg: String(i) });
    expect(adapter.files.size).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect((await log.readAll()).length).toBe(50);
  });

  it('keeps 14 days and at most the size limit, never dropping today', async () => {
    const adapter = new MemoryAdapter();
    let now = new Date(2026, 10, 1, 12).getTime();
    const log = new EventLog(adapter, { now: () => now, maxBytes: 600 });
    for (let d = 0; d < 20; d++) {
      log.record({ op: 'log', msg: 'x'.repeat(100) });
      await log.flush();
      now += DAY;
    }
    now -= DAY;
    await log.prune();
    const files = await log.files();
    expect(files.at(-1)).toContain('2026-11-20');
    expect(files.every((f) => f.slice(-16, -6) >= '2026-11-06')).toBe(true);
    expect(files.length).toBeLessThanOrEqual(4);
  });

  it('keeps lines when a write fails and writes them later', async () => {
    const adapter = new MemoryAdapter();
    const log = new EventLog(adapter);
    adapter.failWrites = true;
    log.record({ op: 'log', msg: 'first' });
    await log.flush();
    expect(log.lastWriteError).toBe('EIO');
    adapter.failWrites = false;
    await log.flush();
    expect((await log.readAll()).map((r) => r.msg)).toEqual(['first']);
  });

  it('logger warnings and errors always reach the log, debug only with the switch', async () => {
    const adapter = new MemoryAdapter();
    const log = new EventLog(adapter);
    setLogSink(log);
    const orig = { w: console.warn, e: console.error };
    console.warn = () => {}; console.error = () => {};
    try {
      logger.debug('quiet');
      logger.warn('backup failed for', 'a.md');
      logger.error(new Error('write failed'));
    } finally { console.warn = orig.w; console.error = orig.e; }
    const recs = await log.readAll();
    expect(recs.map((r) => [r.level, r.msg])).toEqual([['warn', 'backup failed for a.md'], ['error', 'write failed']]);
  });
});
