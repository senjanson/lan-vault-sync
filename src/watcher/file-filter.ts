import { TEXT_EXTENSIONS } from '../constants';
import { inScope, normalizeSyncFolder, type SyncScope } from '../sync/sync-scope';

export class FileFilter {
  private ignoredPaths: string[];
  /** See settings.syncFolder; null (an invalid folder) ignores everything. */
  private scope: SyncScope;

  /** `syncFolder`: sync only this folder (settings.syncFolder); "" for the whole vault. */
  constructor(ignoredPaths: string[], syncFolder: string = '') {
    this.ignoredPaths = ignoredPaths;
    this.scope = normalizeSyncFolder(syncFolder);
  }

  updateIgnoredPaths(paths: string[]): void {
    this.ignoredPaths = paths;
  }

  /** The folder this device syncs, as a scope (see sync-scope). */
  getScope(): SyncScope {
    return this.scope;
  }

  /** Ignored: in an ignored path, or outside the folder this device syncs. */
  shouldIgnore(filePath: string): boolean {
    if (!inScope(filePath, this.scope)) return true;
    return this.ignoredPaths.some(pattern => {
      if (pattern.endsWith('/')) {
        return filePath.startsWith(pattern) || filePath.startsWith(pattern.slice(0, -1));
      }
      return filePath === pattern || filePath.startsWith(pattern + '/');
    });
  }

  isTextFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return TEXT_EXTENSIONS.has(ext);
  }
}
