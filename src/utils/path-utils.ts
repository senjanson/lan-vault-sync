export interface MinimalAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

export function getParentDir(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index > 0 ? filePath.substring(0, index) : '';
}

export async function ensureDirectory(adapter: MinimalAdapter, dir: string): Promise<void> {
  if (!dir || dir === '.') return;
  if (await adapter.exists(dir)) return;

  const parent = getParentDir(dir);
  if (parent && parent !== dir) {
    await ensureDirectory(adapter, parent);
  }

  if (!(await adapter.exists(dir))) {
    await adapter.mkdir(dir);
  }
}

export async function ensureParentDirectory(adapter: MinimalAdapter, filePath: string): Promise<void> {
  const dir = getParentDir(filePath);
  if (!dir) return;
  await ensureDirectory(adapter, dir);
}

/**
 * Whether a path received from a peer may be read or written in the vault.
 * Checks whole path segments, so names like "v1..2.md" stay allowed while
 * traversal, absolute or drive-letter paths and hidden folders (such as the
 * .obsidian config folder, which holds plugin code) are refused.
 */
export function isSafeSyncPath(filePath: string): boolean {
  if (!filePath || filePath.includes('\0')) return false;
  if (filePath.startsWith('/') || filePath.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(filePath)) return false;
  for (const segment of filePath.split('/')) {
    if (!segment || segment === '.' || segment === '..') return false;
    if (segment.startsWith('.')) return false;
  }
  return true;
}

/**
 * Whether two paths differ only in letter case. On storage that does not
 * tell such names apart (Android's shared storage, default macOS and iOS
 * volumes) they name the same file.
 */
export function isCaseVariant(a: string, b: string): boolean {
  return a !== b && a.toLowerCase() === b.toLowerCase();
}

/**
 * The characters in a path that Obsidian does not allow in file names (nor
 * do the file systems of Windows and Android), quoted and comma-separated;
 * empty when there are none. A file whose name holds one can be made outside
 * Obsidian on a Mac or iPhone, but no other device can create it.
 */
export function unportableNameChars(filePath: string): string {
  const found = new Set(filePath.match(/[*"<>:|?]/g) ?? []);
  return [...found].map((c) => `"${c}"`).join(", ");
}
