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
  private onRemoteUpdateAppliedCb:
    | ((filePath: string, update: Uint8Array, fromDeviceId: string) => void)
    | null = null;
  /** previousContent is undefined when the doc was replaced by an unrelated
   *  history, so the caller must back up whatever is on disk. */
  private onRemoteContentCb:
    | ((filePath: string, content: string, previousContent: string | undefined) => Promise<void> | void)
    | null = null;

  constructor(private vault: Vault) {
    this.pool = new DocPool();
    this.persistence = new StatePersistence(vault, (vault as any).adapter);

    // Evict inside the path's queue, so no operation on that doc is running
    // and later ones wait for the saved state.
    this.pool.setEvictHandler((path) => {
      void this._enqueueForPath(path, async () => {
        const doc = this.pool.peek(path);
        if (!doc) {
          this.pool.cancelEviction(path);
          return;
        }
        await this.persistence.saveDoc(path, doc);
        this.pool.evict(path, doc);
      }).catch((err) => {
        this.pool.cancelEviction(path);
        logger.error(`Failed to evict CRDT doc ${path}:`, err);
      });
    });
  }

  /** Register callback: fired when a local edit produces a Yjs update to broadcast */
  onLocalUpdate(cb: (filePath: string, update: Uint8Array) => void): void {
    this.onLocalUpdateCb = cb;
  }

  /**
   * Called with the part of a peer's update that was new to this doc. Yjs
   * reports nothing for updates the doc already had, so forwarding these to
   * other peers cannot loop.
   */
  onRemoteUpdateApplied(
    cb: (filePath: string, update: Uint8Array, fromDeviceId: string) => void,
  ): void {
    this.onRemoteUpdateAppliedCb = cb;
  }

  /** Register callback: fired when a remote update changes doc content → should write to file */
  onRemoteContent(
    cb: (filePath: string, content: string, previousContent: string | undefined) => Promise<void> | void,
  ): void {
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
      } else if (origin instanceof RemoteOrigin) {
        this.onRemoteUpdateAppliedCb?.(filePath, update, origin.deviceId);
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
  async applyRemoteUpdate(filePath: string, update: Uint8Array, fromDeviceId?: string): Promise<void> {
    let remoteContentChange:
      | { content: string; previousContent: string }
      | null = null;

    await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      const previousContent = doc.getText('content').toString();
      Y.applyUpdate(doc, update, remoteOrigin(fromDeviceId));

      const ytext = doc.getText('content');
      const content = ytext.toString();
      this.lastKnownContent.set(filePath, content);

      if (content !== previousContent) {
        remoteContentChange = { content, previousContent };
      }
    });

    if (remoteContentChange) {
      await this.onRemoteContentCb?.(
        filePath,
        remoteContentChange.content,
        remoteContentChange.previousContent,
      );
    }
  }

  /**
   * Compare this doc's history with a peer's state vector.
   *
   * Two Y.Docs that were each seeded from disk on their own share no client
   * IDs; merging them concatenates both copies of the text. Docs with shared
   * history always share at least the client that inserted the base text.
   * When histories are unrelated, both sides pick the same winner (the doc
   * whose smallest client ID is lower) so they converge on one doc.
   */
  async compareHistory(
    filePath: string,
    remoteStateVector: Uint8Array,
  ): Promise<'related' | 'local-wins' | 'remote-wins'> {
    return this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      return compareStateVectors(
        Y.decodeStateVector(Y.encodeStateVector(doc)),
        Y.decodeStateVector(remoteStateVector),
      );
    });
  }

  /**
   * Apply a peer's complete doc state. Related histories merge as usual. For
   * unrelated histories the winning doc is kept: either ours (returns
   * 'kept-local', the caller sends our state back) or theirs, which replaces
   * our doc instead of being merged into it (returns 'adopted').
   */
  async applyFullState(
    filePath: string,
    update: Uint8Array,
    fromDeviceId?: string,
  ): Promise<'merged' | 'adopted' | 'kept-local'> {
    let result: 'merged' | 'adopted' | 'kept-local' = 'merged';
    let change: { content: string; previousContent: string | undefined } | null = null;

    await this._enqueueForPath(filePath, async () => {
      let doc = await this.getOrCreateDoc(filePath);
      const previousContent = doc.getText('content').toString();
      const relation = compareStateVectors(
        Y.decodeStateVector(Y.encodeStateVector(doc)),
        Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update)),
      );

      if (relation === 'local-wins') {
        result = 'kept-local';
        return;
      }
      if (relation === 'remote-wins') {
        result = 'adopted';
        this.pool.delete(filePath);
        this.lastKnownContent.delete(filePath);
        await this.persistence.deleteDoc(filePath);
        doc = await this.getOrCreateDoc(filePath);
      }

      // An adopted history is not forwarded as an update: peers holding the
      // dropped history would merge it into theirs. The caller sends it to
      // them as a full state instead.
      Y.applyUpdate(doc, update, result === 'adopted' ? 'remote' : remoteOrigin(fromDeviceId));
      const content = doc.getText('content').toString();
      this.lastKnownContent.set(filePath, content);
      if (result === 'adopted' || content !== previousContent) {
        change = {
          content,
          previousContent: result === 'adopted' ? undefined : previousContent,
        };
      }
    });

    const pending = change as { content: string; previousContent: string | undefined } | null;
    if (pending) {
      await this.onRemoteContentCb?.(filePath, pending.content, pending.previousContent);
    }
    return result;
  }

  /** Generate sync step 1 (state vector) for initial sync with a new peer */
  /** Whether a peer's state vector includes changes this doc lacks. */
  async isMissingRemoteChanges(filePath: string, remoteStateVector: Uint8Array): Promise<boolean> {
    return this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      const local = Y.decodeStateVector(Y.encodeStateVector(doc));
      for (const [client, clock] of Y.decodeStateVector(remoteStateVector)) {
        if (clock > (local.get(client) ?? 0)) return true;
      }
      return false;
    });
  }

  async encodeSyncStep1(filePath: string): Promise<Uint8Array> {
    return this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      return Y.encodeStateVector(doc);
    });
  }

  async encodeFullState(filePath: string): Promise<Uint8Array> {
    return this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      return Y.encodeStateAsUpdate(doc);
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
  async handleSyncStep2(filePath: string, data: Uint8Array, fromDeviceId?: string): Promise<void> {
    let remoteContentChange:
      | { content: string; previousContent: string }
      | null = null;

    await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      const previousContent = doc.getText('content').toString();
      Y.applyUpdate(doc, data, remoteOrigin(fromDeviceId));

      // Update last known content
      const ytext = doc.getText('content');
      const content = ytext.toString();
      this.lastKnownContent.set(filePath, content);
      if (content !== previousContent) {
        remoteContentChange = { content, previousContent };
      }
    });

    if (remoteContentChange) {
      await this.onRemoteContentCb?.(
        filePath,
        remoteContentChange.content,
        remoteContentChange.previousContent,
      );
    }
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
   *
   * If the doc already exists and its content matches `content`, this is a
   * no-op.  If the doc exists but has *different* content (e.g. restored from
   * stale persistence), the diff is applied silently so the doc reflects the
   * actual on-disk state before the sync exchange begins.
   */
  async initDocFromContentSilent(filePath: string, content: string): Promise<void> {
    await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      const ytext = doc.getText('content');
      const existing = ytext.toString();

      if (existing === content) {
        // Already up-to-date — nothing to do.
        this.lastKnownContent.set(filePath, content);
        return;
      }

      // Use a neutral origin ('init') so the update listener does not fire
      // the local-broadcast callback.
      if (ytext.length === 0 && content.length > 0) {
        doc.transact(() => {
          ytext.insert(0, content);
        }, 'init');
      } else if (existing !== content) {
        // Doc has stale/different content — apply diff silently.
        doc.transact(() => {
          const diffs = diff(existing, content);
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

  async hasDocState(filePath: string): Promise<boolean> {
    if (this.pool.has(filePath)) return true;
    return this.persistence.hasDoc(filePath);
  }

  /** Remove a doc (file was deleted) */
  async removeDoc(filePath: string): Promise<void> {
    await this._enqueueForPath(filePath, async () => {
      this.pool.delete(filePath);
      this.lastKnownContent.delete(filePath);
      await this.persistence.deleteDoc(filePath);
    });
  }

  async renameDoc(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;

    await this._enqueueForPath(oldPath, async () => {
      await this._enqueueForPath(newPath, async () => {
        if (this.pool.has(oldPath)) {
          this.pool.rename(oldPath, newPath);
        }

        const content = this.lastKnownContent.get(oldPath);
        if (content !== undefined) {
          this.lastKnownContent.set(newPath, content);
          this.lastKnownContent.delete(oldPath);
        }

        await this.persistence.renameDoc(oldPath, newPath);
      });
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
    await this.pool.destroyAll((path, doc) => this.persistence.saveDoc(path, doc));
    this.lastKnownContent.clear();
  }
}

/** See YjsDocManager.compareHistory. */
export function compareStateVectors(
  local: Map<number, number>,
  remote: Map<number, number>,
): 'related' | 'local-wins' | 'remote-wins' {
  if (local.size === 0 || remote.size === 0) return 'related';
  for (const client of local.keys()) {
    if (remote.has(client)) return 'related';
  }
  return Math.min(...local.keys()) < Math.min(...remote.keys())
    ? 'local-wins'
    : 'remote-wins';
}

/** Transaction origin for updates received from a peer. */
class RemoteOrigin {
  constructor(readonly deviceId: string) {}
}

function remoteOrigin(deviceId: string | undefined): RemoteOrigin | 'remote' {
  return deviceId ? new RemoteOrigin(deviceId) : 'remote';
}
