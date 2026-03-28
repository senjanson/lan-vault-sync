import { createHash } from 'crypto';

export async function computeFileHash(data: ArrayBuffer): Promise<string> {
  const hash = createHash('sha256');
  hash.update(Buffer.from(data));
  return hash.digest('hex');
}
