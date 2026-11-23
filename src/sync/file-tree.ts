import { Vault } from 'obsidian';
import { FileMeta } from '../types';
import { FileFilter } from '../watcher/file-filter';
import { computeFileHash } from '../binary-sync/file-hash';
import { isPlainUtf8 } from '../utils/utf8';

export interface FileTreeSnapshot {
  files: Map<string, FileMeta>;
  timestamp: number;
}

/**
 * Hashes from earlier builds, reused while a file's size and mtime stay the
 * same; for text files also whether they are plain UTF-8 (see isPlainUtf8).
 */
export type FileHashCache = Map<string, { mtime: number; size: number; hash: string; plain?: boolean }>;

export async function buildFileTree(
  vault: Vault,
  filter: FileFilter,
  cache?: FileHashCache,
): Promise<FileTreeSnapshot> {
  const files = new Map<string, FileMeta>();
  const allFiles = vault.getFiles();

  for (const file of allFiles) {
    if (filter.shouldIgnore(file.path)) continue;

    let isText = filter.isTextFile(file.path);
    let hash = '';
    const cached = cache?.get(file.path);

    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size && (!isText || cached.plain !== undefined)) {
      hash = cached.hash;
      if (isText) isText = cached.plain === true;
    } else {
      try {
        const data = await vault.readBinary(file);
        hash = await computeFileHash(data);
        // Synced as bytes, like an attachment, when it is not plain UTF-8.
        if (isText) isText = isPlainUtf8(new Uint8Array(data));
      } catch {
        // File may have been deleted between listing and reading
        continue;
      }
      cache?.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, hash, plain: filter.isTextFile(file.path) ? isText : undefined });
    }

    files.set(file.path, {
      path: file.path,
      hash,
      mtime: file.stat.mtime,
      size: file.stat.size,
      isTextFile: isText,
    });
  }

  if (cache) {
    for (const path of cache.keys()) if (!files.has(path)) cache.delete(path);
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
