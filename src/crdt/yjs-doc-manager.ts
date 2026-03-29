import { Vault } from 'obsidian';
import * as Y from 'yjs';
import diff from 'fast-diff';
import { DocPool } from './doc-pool';
import { StatePersistence } from './state-persistence';
import { applyDiffToYText } from './text-diff';
import { logger } from '../logger';

export class YjsDocManager {
  private pool: DocPool;
  private persistence: StatePersistence;
  private lastKnownContent = new Map<string, string>();
  private pendingDocs = new Map<string, Promise<Y.Doc>>();
  private operationQueues = new Map<string, Promise<void>>();

  // Callbacks
  private onLocalUpdateCb: ((filePath: string, update: Uint8Array) => void) | null = null;
  private onRemoteContentCb: ((filePath: string, content: string, previousContent: string) => void) | null = null;

  constructor(private vault: Vault) {
    this.pool = new DocPool();
    this.persistence = new StatePersistence(vault, (vault as any).adapter);

    this.pool.setEvictHandler(async (path, doc) => {
      await this.persistence.saveDoc(path, doc);
    });
  }

  /** Register callback: fired when a local edit produces a Yjs update to broadcast */
  onLocalUpdate(cb: (filePath: string, update: Uint8Array) => void): void {
    this.onLocalUpdateCb = cb;
  }

  /** Register callback: fired when a remote update changes doc content → should write to file */
  onRemoteContent(cb: (filePath: string, content: string, previousContent: string) => void): void {
    this.onRemoteContentCb = cb;
  }

  /** Get or create the Y.Doc for a file path (serialized per path to prevent races) */
  async getOrCreateDoc(filePath: string): Promise<Y.Doc> {
    const existing = this.pool.get(filePath);
    if (existing) return existing;

    // If another call is already creating this doc, wait for it
    const pending = this.pendingDocs.get(filePath);
    if (pending) return pending;

    const promise = this._createDoc(filePath);
    this.pendingDocs.set(filePath, promise);
    try {
      return await promise;
    } finally {
      this.pendingDocs.delete(filePath);
    }
  }

  private async _createDoc(filePath: string): Promise<Y.Doc> {
    // Double-check after await in case another call snuck in
    const existing = this.pool.get(filePath);
    if (existing) return existing;

    const doc = new Y.Doc();
    // Try to restore persisted state
    await this.persistence.loadDoc(filePath, doc);

    // Listen for updates originating locally
    doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin === 'local') {
        this.onLocalUpdateCb?.(filePath, update);
      }
    });

    this.pool.set(filePath, doc);
    return doc;
  }

  private async _enqueueForPath<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(filePath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queueTail = previous.then(() => current);

    this.operationQueues.set(filePath, queueTail);

    try {
      await previous;
      return await operation();
    } finally {
      release();

      if (this.operationQueues.get(filePath) === queueTail) {
        this.operationQueues.delete(filePath);
      }
    }
  }

  /** Called when a local file changes. Computes diff and applies to Yjs doc. */
  async applyLocalChange(filePath: string, newContent: string): Promise<void> {
    await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      const ytext = doc.getText('content');
      const oldContent = this.lastKnownContent.get(filePath) ?? ytext.toString();

      if (oldContent === newContent) return;

      doc.transact(() => {
        const diffs = diff(oldContent, newContent);
        let index = 0;
        for (const [op, text] of diffs) {
          if (op === diff.EQUAL) {
            index += text.length;
          } else if (op === diff.INSERT) {
            ytext.insert(index, text);
            index += text.length;
          } else if (op === diff.DELETE) {
            ytext.delete(index, text.length);
          }
        }
      }, 'local');

      this.lastKnownContent.set(filePath, newContent);
    });
  }

  /** Called when receiving a Yjs update from a remote peer */
  async applyRemoteUpdate(filePath: string, update: Uint8Array): Promise<void> {
    await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      const previousContent = doc.getText('content').toString();
      Y.applyUpdate(doc, update, 'remote');

      const ytext = doc.getText('content');
      const content = ytext.toString();
      this.lastKnownContent.set(filePath, content);

      if (content !== previousContent) {
        this.onRemoteContentCb?.(filePath, content, previousContent);
      }
    });
  }

  /** Generate sync step 1 (state vector) for initial sync with a new peer */
  async encodeSyncStep1(filePath: string): Promise<Uint8Array> {
    return this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      return Y.encodeStateVector(doc);
    });
  }

  /** Handle sync step 1 from peer (state vector), produce sync step 2 (update diff) */
  async handleSyncStep1(filePath: string, data: Uint8Array): Promise<Uint8Array> {
    return this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      // data is the remote peer's state vector; produce the diff update
      return Y.encodeStateAsUpdate(doc, data);
    });
  }

  /** Handle sync step 2 from peer (update diff) */
  async handleSyncStep2(filePath: string, data: Uint8Array): Promise<void> {
    await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      const previousContent = doc.getText('content').toString();
      Y.applyUpdate(doc, data, 'remote');

      // Update last known content
      const ytext = doc.getText('content');
      const content = ytext.toString();
      this.lastKnownContent.set(filePath, content);
      if (content !== previousContent) {
        this.onRemoteContentCb?.(filePath, content, previousContent);
      }
    });
  }

  /** Initialize a doc with file content (for first-time setup) */
  async initDocWithContent(filePath: string, content: string): Promise<void> {
    await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      const ytext = doc.getText('content');

      if (ytext.length === 0 && content.length > 0) {
        doc.transact(() => {
          ytext.insert(0, content);
        }, 'local');
      } else if (ytext.length > 0) {
        // Doc already has content (from persistence), apply diff
        const existing = ytext.toString();
        if (existing !== content) {
          applyDiffToYText(ytext, existing, content);
        }
      }

      this.lastKnownContent.set(filePath, content);
    });
  }

  /** Return true if a doc is currently active (loaded) in the pool. */
  isDocActive(filePath: string): boolean {
    return this.pool.has(filePath);
  }

  /**
   * Initialize a doc from known content WITHOUT broadcasting the insert as a
   * local update. Used for conflict-resolution CRDT exchange so we don't
   * inadvertently push our full content to all peers before the merge step.
   * No-op if the doc is already active.
   */
  async initDocFromContentSilent(filePath: string, content: string): Promise<void> {
    await this._enqueueForPath(filePath, async () => {
      if (this.pool.has(filePath)) return;

      const doc = await this.getOrCreateDoc(filePath);
      const ytext = doc.getText('content');

      if (ytext.length === 0 && content.length > 0) {
        // Use a neutral origin ('init') so the update listener does not fire
        // the local-broadcast callback.
        doc.transact(() => {
          ytext.insert(0, content);
        }, 'init');
      }

      this.lastKnownContent.set(filePath, ytext.toString());
    });
  }

  async getContent(filePath: string): Promise<string> {
    return this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      const content = doc.getText('content').toString();
      this.lastKnownContent.set(filePath, content);
      return content;
    });
  }

  /** Remove a doc (file was deleted) */
  async removeDoc(filePath: string): Promise<void> {
    await this._enqueueForPath(filePath, async () => {
      this.pool.delete(filePath);
      this.lastKnownContent.delete(filePath);
      await this.persistence.deleteDoc(filePath);
    });
  }

  /** Persist all active docs */
  async persistAll(): Promise<void> {
    const docs = this.pool.getAll();
    for (const [path, doc] of docs) {
      await this.persistence.saveDoc(path, doc);
    }
  }

  /** Get all tracked file paths */
  getTrackedPaths(): string[] {
    return Array.from(this.pool.getAll().keys());
  }

  async destroy(): Promise<void> {
    await this.pool.destroyAll();
    this.lastKnownContent.clear();
  }
}
