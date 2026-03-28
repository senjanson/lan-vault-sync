import { Vault, TFile } from 'obsidian';
import { FileMeta } from '../types';
import { FileFilter } from '../watcher/file-filter';
import { computeFileHash } from '../binary-sync/file-hash';

export interface FileTreeSnapshot {
  files: Map<string, FileMeta>;
  timestamp: number;
}

export async function buildFileTree(vault: Vault, filter: FileFilter): Promise<FileTreeSnapshot> {
  const files = new Map<string, FileMeta>();
  const allFiles = vault.getFiles();

  for (const file of allFiles) {
    if (filter.shouldIgnore(file.path)) continue;

    const isText = filter.isTextFile(file.path);
    let hash = '';

    try {
      const data = await vault.readBinary(file);
      hash = await computeFileHash(data);
    } catch {
      // File may have been deleted between listing and reading
      continue;
    }

    files.set(file.path, {
      path: file.path,
      hash,
      mtime: file.stat.mtime,
      size: file.stat.size,
      isTextFile: isText,
    });
  }

  return { files, timestamp: Date.now() };
}

export interface FileTreeDiff {
  /** Files that exist locally but not on remote */
  localOnly: FileMeta[];
  /** Files that exist on remote but not locally */
  remoteOnly: FileMeta[];
  /** Files that exist on both but have different content */
  conflicting: Array<{ local: FileMeta; remote: FileMeta }>;
}

export function diffFileTrees(
  local: Map<string, FileMeta>,
  remote: Map<string, FileMeta>
): FileTreeDiff {
  const localOnly: FileMeta[] = [];
  const remoteOnly: FileMeta[] = [];
  const conflicting: Array<{ local: FileMeta; remote: FileMeta }> = [];

  for (const [path, localMeta] of local) {
    const remoteMeta = remote.get(path);
    if (!remoteMeta) {
      localOnly.push(localMeta);
    } else if (localMeta.hash !== remoteMeta.hash) {
      conflicting.push({ local: localMeta, remote: remoteMeta });
    }
  }

  for (const [path, remoteMeta] of remote) {
    if (!local.has(path)) {
      remoteOnly.push(remoteMeta);
    }
  }

  return { localOnly, remoteOnly, conflicting };
}
