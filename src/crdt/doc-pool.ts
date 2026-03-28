import * as Y from 'yjs';
import { MAX_ACTIVE_DOCS } from '../constants';
import { logger } from '../logger';

/**
 * A simple LRU pool that keeps at most MAX_ACTIVE_DOCS Y.Doc instances
 * in memory. Evicted docs have their state snapshot saved via a callback
 * before being destroyed.
 */
export class DocPool {
  private docs = new Map<string, { doc: Y.Doc; lastAccess: number }>();
  private onEvict: ((path: string, doc: Y.Doc) => Promise<void>) | null = null;

  setEvictHandler(handler: (path: string, doc: Y.Doc) => Promise<void>): void {
    this.onEvict = handler;
  }

  get(path: string): Y.Doc | undefined {
    const entry = this.docs.get(path);
    if (entry) {
      entry.lastAccess = Date.now();
      return entry.doc;
    }
    return undefined;
  }

  set(path: string, doc: Y.Doc): void {
    this.docs.set(path, { doc, lastAccess: Date.now() });
    this._maybeEvict();
  }

  has(path: string): boolean {
    return this.docs.has(path);
  }

  delete(path: string): void {
    const entry = this.docs.get(path);
    if (entry) {
      entry.doc.destroy();
      this.docs.delete(path);
    }
  }

  getAll(): Map<string, Y.Doc> {
    const result = new Map<string, Y.Doc>();
    for (const [path, entry] of this.docs) {
      result.set(path, entry.doc);
    }
    return result;
  }

  async destroyAll(): Promise<void> {
    for (const [path, entry] of this.docs) {
      if (this.onEvict) {
        await this.onEvict(path, entry.doc);
      }
      entry.doc.destroy();
    }
    this.docs.clear();
  }

  private async _maybeEvict(): Promise<void> {
    if (this.docs.size <= MAX_ACTIVE_DOCS) return;

    // Find LRU entry
    let oldestPath: string | null = null;
    let oldestTime = Infinity;
    for (const [path, entry] of this.docs) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestPath = path;
      }
    }

    if (oldestPath) {
      const entry = this.docs.get(oldestPath)!;
      logger.debug(`Evicting doc from pool: ${oldestPath}`);
      if (this.onEvict) {
        await this.onEvict(oldestPath, entry.doc);
      }
      entry.doc.destroy();
      this.docs.delete(oldestPath);
    }
  }
}
