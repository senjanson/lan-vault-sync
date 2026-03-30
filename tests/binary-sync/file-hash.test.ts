import { describe, expect, it } from 'vitest';

import { computeFileHash } from '../../src/binary-sync/file-hash';

describe('computeFileHash', () => {
  it('returns a stable SHA-256 hash without Node crypto', async () => {
    const data = new TextEncoder().encode('hello from mobile').buffer;

    await expect(computeFileHash(data)).resolves.toBe(
      '5f93d08338ba4d32ea18da010bf4cbf67153bfc0484d606e44d3554a6b5b3c95',
    );
  });
});
