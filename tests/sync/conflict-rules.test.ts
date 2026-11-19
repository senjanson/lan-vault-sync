import { describe, expect, it } from 'vitest';
import { decideConflict, localIsWinner } from '../../src/sync/conflict-rules';
import type { FileMeta } from '../../src/types';

const meta = (hash: string, mtime: number, extra: Partial<FileMeta> = {}): FileMeta => ({
  path: 'n.md', hash, mtime, size: 1, isTextFile: true, ...extra,
});

describe('decideConflict', () => {
  it('lets the side that changed win, without a copy, when one side still has the shared version', () => {
    const r = decideConflict({ local: meta('old', 9), remote: meta('new', 1), deviceId: 'a', remoteDeviceId: 'b', agreed: 'old' });
    expect(r).toEqual({ localWins: false, keepCopy: false });
    const s = decideConflict({ local: meta('new', 1), remote: meta('old', 9, { agreed: 'old' }), deviceId: 'a', remoteDeviceId: 'b' });
    expect(s).toEqual({ localWins: true, keepCopy: false });
  });

  it('keeps a copy and goes by when each version was made when both changed', () => {
    const r = decideConflict({ local: meta('x', 50, { madeAt: 5 }), remote: meta('y', 10, { madeAt: 8 }), deviceId: 'a', remoteDeviceId: 'b', agreed: 'o' });
    expect(r).toEqual({ localWins: false, keepCopy: true });
  });

  it('decides the same on both devices', () => {
    const l = meta('x', 7);
    const rm = meta('y', 7);
    const here = decideConflict({ local: l, remote: rm, deviceId: 'a', remoteDeviceId: 'b' });
    const there = decideConflict({ local: rm, remote: l, deviceId: 'b', remoteDeviceId: 'a' });
    expect(here.localWins).toBe(!there.localWins);
    expect(localIsWinner(1, 1, 'a', 'b')).toBe(true);
  });

  it('lets a file made anew after a deletion win over the deleted copy', () => {
    expect(decideConflict({ local: meta('n', 1), remote: meta('d', 9), deviceId: 'a', remoteDeviceId: 'b', revivedHash: 'd' }))
      .toEqual({ localWins: true, keepCopy: false });
  });
});
