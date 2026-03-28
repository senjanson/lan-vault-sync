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
