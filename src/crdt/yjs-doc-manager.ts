import { Vault } from 'obsidian';
import * as Y from 'yjs';
import diff from 'fast-diff';
import { DocPool } from './doc-pool';
import { docDigest, StatePersistence } from './state-persistence';
import { applyDiffToYText, applyRebasedEdit } from './text-diff';
import { logger } from '../logger';

export class YjsDocManager {
  private pool: DocPool;
  private persistence: StatePersistence;
  /**
   * The text the file on disk (or its open editor) is known to hold. Local
   * edits are diffed against this, not against the doc, which may already
   * contain peer changes that have not reached the editor yet.
   */
  private lastKnownContent = new Map<string, string>();
  /** Docs that hold their note's current text; see isDocSeeded. */
  private seeded = new WeakSet<Y.Doc>();
  /** Paths whose doc was seeded when it was evicted from the pool. */
  private evictedSeeded = new Set<string>();
  /** Docs loaded from their saved state and not changed since. */
  private unchanged = new WeakSet<Y.Doc>();
  /** Docs with changes that are not in their state file yet. */
  private dirty = new WeakSet<Y.Doc>();
  /** Where each loaded doc is kept now; a rename moves it. */
  private docPaths = new WeakMap<Y.Doc, string>();
  /** Local updates held back until the doc that made them is saved. */
  private outbox = new WeakMap<Y.Doc, Array<{ path: string; update: Uint8Array }>>();
  private commitQueued = new Set<string>();
  /**
   * The text the note's file on disk is known to hold. It lags behind the
   * doc while a peer's edit is being written, and while an edit shown in an
   * editor waits for Obsidian to save it. A state saved in that time records
   * this text (see _save): if the app stops before the file catches up, the
   * next start can tell that the doc is ahead of the file from the file
   * having been changed, and need not take the difference for a new edit.
   */
  private diskContent = new Map<string, string>();
  /** The file text recorded in a note's state file, for notes that have one. */
  private savedBase = new Map<string, string>();
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

  private keepsWrittenContent: (filePath: string) => boolean = () => false;

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
        // A doc that did not change since it was loaded is saved already.
        // Resaving it cost a write for each doc touched, thousands when a
        // peer connects.
        if (!this.unchanged.has(doc)) await this._save(path, doc);
        this._sendHeldUpdates(doc);
        // The saved state is the note's text: loaded again, it needs no
        // seeding from the file, which may lag behind it.
        if (this.seeded.has(doc)) this.evictedSeeded.add(path);
        // The file's last written text is only kept for loaded docs. A doc
        // loaded again holds that same text, which then serves as the base
        // for the next local edit. Kept while the doc holds text that is
        // not written yet, or while the note is open in an editor.
        if (
          !this.keepsWrittenContent(path) &&
          this.lastKnownContent.get(path) === doc.getText('content').toString()
        ) {
          this.lastKnownContent.delete(path);
        }
        if (this.diskContent.get(path) === doc.getText('content').toString()) {
          this.diskContent.delete(path);
        }
        this.pool.evict(path, doc);
      }).catch((err) => {
        this.pool.cancelEviction(path);
        logger.error(`Failed to evict CRDT doc ${path}:`, err);
      });
    });
  }

  /** Tell which notes must keep their last written text when unloaded. */
  setKeepsWrittenContent(cb: (filePath: string) => boolean): void {
    this.keepsWrittenContent = cb;
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
    const saved = await this.persistence.loadState(filePath, doc);
    if (saved) this.unchanged.add(doc);
    if (saved?.base !== undefined) {
      this.savedBase.set(filePath, saved.base);
      if (!this.diskContent.has(filePath)) this.diskContent.set(filePath, saved.base);
    } else {
      this.savedBase.delete(filePath);
    }
    if (this.evictedSeeded.delete(filePath)) this.seeded.add(doc);
    this.docPaths.set(doc, filePath);

    doc.on('update', (update: Uint8Array, origin: any) => {
      this.unchanged.delete(doc);
      this.dirty.add(doc);
      // Where the note is now: a doc keeps its updates' path across renames,
      // and an update sent under the old name would bring that name back on
      // a peer that has not seen the rename.
      const path = this.docPaths.get(doc) ?? filePath;
      if (origin === 'local') {
        // Sent once the doc is saved (see _commit).
        const held = this.outbox.get(doc);
        if (held) held.push({ path, update });
        else this.outbox.set(doc, [{ path, update }]);
      } else if (origin instanceof RemoteOrigin) {
        this.onRemoteUpdateAppliedCb?.(path, update, origin.deviceId);
      }
      // A peer's text for a note that has no file here yet is saved once the
      // file is written (see noteDiskContent). Saved before, an app stopped
      // in between would come back with the text and no file to put it in.
      const awaitsFile = origin !== 'local' && origin !== 'init' && !this.diskContent.has(path);
      if (!awaitsFile) this._scheduleCommit(doc);
    });

    this.pool.set(filePath, doc);
    return doc;
  }

  /**
   * Save a doc's state, with the file's text when the doc is ahead of the
   * file (see diskContent).
   */
  private async _save(path: string, doc: Y.Doc): Promise<void> {
    this.dirty.delete(doc);
    const disk = this.diskContent.get(path);
    const base = disk !== undefined && disk !== doc.getText('content').toString() ? disk : undefined;
    if (await this.persistence.saveDoc(path, doc, base)) {
      if (base === undefined) this.savedBase.delete(path);
      else this.savedBase.set(path, base);
      if (!this.dirty.has(doc)) this.unchanged.add(doc);
    } else {
      this.dirty.add(doc);
    }
  }

  private _sendHeldUpdates(doc: Y.Doc): void {
    const held = this.outbox.get(doc);
    if (!held) return;
    this.outbox.delete(doc);
    for (const { path, update } of held) this.onLocalUpdateCb?.(path, update);
  }

  /**
   * Save a changed doc, then hand its local updates to onLocalUpdate. The
   * state used to be saved once a minute: an app that stopped before that
   * came back with a state older than its file, took the difference for a
   * new edit, and so added again what peers had already received. A change
   * is now saved before peers get it and before it is written to the file.
   * Must run inside the path's queue.
   */
  private async _commit(path: string, doc: Y.Doc): Promise<void> {
    if (this.dirty.has(doc)) await this._save(path, doc);
    this._sendHeldUpdates(doc);
  }

  /** Queue a commit behind the operation that is changing the doc. */
  private _scheduleCommit(doc: Y.Doc): void {
    const path = this.docPaths.get(doc);
    if (path === undefined || this.commitQueued.has(path)) return;
    this.commitQueued.add(path);
    void this._enqueueForPath(path, async () => {
      this.commitQueued.delete(path);
      if (this.pool.peek(path) === doc) await this._commit(path, doc);
      else this._sendHeldUpdates(doc);
    }).catch((err) => {
      this.commitQueued.delete(path);
      logger.error(`Failed to save CRDT state for ${path}:`, err);
    });
  }

  /**
   * The text to take as the starting point of what the file now holds, for
   * a doc loaded with a recorded file text (`base`) other than its own
   * (`current`). The file was changed from whichever of the two it is
   * closer to: from `base` if the file never caught up with the doc, from
   * `current` if it did and the record is out of date.
   */
  private _startingPoint(base: string | undefined, current: string, next: string): string {
    if (base === undefined || base === current || next === base) return base ?? current;
    if (next === current) return current;
    return editSize(base, next) <= editSize(current, next) ? base : current;
  }

  /**
   * Record what the note's file on disk holds, when that was read from the
   * file or just written to it.
   */
  noteDiskContent(filePath: string, content: string): void {
    this.diskContent.set(filePath, content);
    const doc = this.pool.peek(filePath);
    if (!doc) return;
    if (this.dirty.has(doc)) {
      this._scheduleCommit(doc);
      return;
    }
    const saved = this.savedBase.get(filePath);
    if (saved === undefined) return;
    // The state file records a file text that no longer holds: save again.
    const needed = content !== doc.getText('content').toString() ? content : undefined;
    if (needed === saved) return;
    this.dirty.add(doc);
    this._scheduleCommit(doc);
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

  /**
   * Called when a local file changes. Computes diff and applies to Yjs doc.
   * `onDisk` tells that the text was read from the file, not from an editor
   * that may not have saved it yet.
   */
  async applyLocalChange(filePath: string, newContent: string, onDisk = false): Promise<void> {
    const ahead = await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      const ytext = doc.getText('content');
      const current = ytext.toString();
      let oldContent = this.lastKnownContent.get(filePath);
      // First change since the doc was loaded: see _startingPoint.
      const recovering = oldContent === undefined && !this.seeded.has(doc);
      if (oldContent === undefined) {
        oldContent = recovering
          ? this._startingPoint(this.savedBase.get(filePath), current, newContent)
          : current;
      }
      this.seeded.add(doc);
      if (onDisk) this.noteDiskContent(filePath, newContent);

      if (oldContent !== newContent) {
        applyRebasedEdit(ytext, oldContent, newContent, 'local');
      }
      if (oldContent !== newContent || recovering) this.lastKnownContent.set(filePath, newContent);
      await this._commit(filePath, doc);

      // The doc was ahead of the file when the app last stopped: what it
      // holds beyond the file still has to be written there.
      const merged = ytext.toString();
      return recovering && merged !== newContent ? merged : null;
    });
    if (ahead !== null) await this.onRemoteContentCb?.(filePath, ahead, newContent);
  }

  /** Called when receiving a Yjs update from a remote peer */
  async applyRemoteUpdate(filePath: string, update: Uint8Array, fromDeviceId?: string): Promise<void> {
    // The change is returned from the queued operation (not assigned to an
    // outer variable) so the callback runs after the queue is released.
    const remoteContentChange = await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      this.seeded.add(doc);
      const previousContent = doc.getText('content').toString();
      Y.applyUpdate(doc, update, remoteOrigin(fromDeviceId));

      const content = doc.getText('content').toString();
      return content !== previousContent ? { content, previousContent } : null;
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
   * When histories are unrelated, both sides must pick the same winner so
   * they converge on one doc: `localWins` when the caller has settled it
   * (see compareStateVectors).
   */
  async compareHistory(
    filePath: string,
    remoteStateVector: Uint8Array,
    localWins?: boolean,
  ): Promise<'related' | 'local-wins' | 'remote-wins'> {
    return this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      return compareStateVectors(
        Y.decodeStateVector(Y.encodeStateVector(doc)),
        Y.decodeStateVector(remoteStateVector),
        localWins,
      );
    });
  }

  /**
   * Whether `update` holds the start of another history of this note: the
   * first insert of a doc that was created on its own on another device.
   * Applied as a normal update it would add that whole text to ours.
   */
  private _startsOtherHistory(doc: Y.Doc, update: Uint8Array): boolean {
    const local = Y.decodeStateVector(Y.encodeStateVector(doc));
    if (local.size === 0) return false;
    for (const struct of Y.decodeUpdate(update).structs) {
      if (
        struct instanceof Y.Item &&
        struct.origin === null &&
        struct.rightOrigin === null &&
        typeof struct.parent === 'string' &&
        !local.has(struct.id.client)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Apply a peer's update unless it starts another history of the note
   * (see _startsOtherHistory); returns false, without applying it, then.
   * The check and the apply are one step, so two peers' separate histories
   * arriving together cannot both be applied to a doc that was empty.
   *
   * `settle`, when given, sees the text before and after an update that
   * changed it, and may return a text to put in the note instead (see
   * restoreText), before anything is written to the file.
   */
  async applyRelatedUpdate(
    filePath: string,
    update: Uint8Array,
    fromDeviceId?: string,
    settle?: (before: string, merged: string) => Promise<string | null>,
  ): Promise<boolean> {
    let related = true;
    const remoteContentChange = await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      if (this._startsOtherHistory(doc, update)) {
        related = false;
        return null;
      }
      this.seeded.add(doc);
      const previousContent = doc.getText('content').toString();
      Y.applyUpdate(doc, update, remoteOrigin(fromDeviceId));
      let content = doc.getText('content').toString();
      if (settle && content !== previousContent) {
        const instead = await settle(previousContent, content);
        if (instead !== null && instead !== content) {
          restoreText(doc, content, instead);
          content = instead;
        }
      }
      return content !== previousContent ? { content, previousContent } : null;
    });

    if (remoteContentChange) {
      await this.onRemoteContentCb?.(
        filePath,
        remoteContentChange.content,
        remoteContentChange.previousContent,
      );
    }
    return related;
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
    localWins?: boolean,
  ): Promise<'merged' | 'adopted' | 'kept-local'> {
    let result: 'merged' | 'adopted' | 'kept-local' = 'merged';
    let change: { content: string; previousContent: string | undefined } | null = null;

    await this._enqueueForPath(filePath, async () => {
      let doc = await this.getOrCreateDoc(filePath);
      const previousContent = doc.getText('content').toString();
      const relation = compareStateVectors(
        Y.decodeStateVector(Y.encodeStateVector(doc)),
        Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update)),
        localWins,
      );

      if (relation === 'local-wins') {
        result = 'kept-local';
        return;
      }
      if (relation === 'remote-wins') {
        result = 'adopted';
        this.pool.delete(filePath);
        this.evictedSeeded.delete(filePath);
        this.lastKnownContent.delete(filePath);
        this.savedBase.delete(filePath);
        await this.persistence.deleteDoc(filePath);
        doc = await this.getOrCreateDoc(filePath);
      }

      // An adopted history is not forwarded as an update: peers holding the
      // dropped history would merge it into theirs. The caller sends it to
      // them as a full state instead.
      Y.applyUpdate(doc, update, result === 'adopted' ? 'remote' : remoteOrigin(fromDeviceId));
      this.seeded.add(doc);
      const content = doc.getText('content').toString();
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
    // The change is returned from the queued operation (not assigned to an
    // outer variable) so the callback runs after the queue is released.
    const remoteContentChange = await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      this.seeded.add(doc);
      const previousContent = doc.getText('content').toString();
      Y.applyUpdate(doc, data, remoteOrigin(fromDeviceId));

      const content = doc.getText('content').toString();
      return content !== previousContent ? { content, previousContent } : null;
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
      this.seeded.add(doc);
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
      await this._commit(filePath, doc);
    });
  }

  /** Return true if a doc is currently active (loaded) in the pool. */
  /**
   * Whether the note's doc is loaded and already holds its current text:
   * seeded from disk, or changed since it was loaded. A doc that was only
   * loaded (to compare histories, say) may still miss what is on disk.
   */
  isDocSeeded(filePath: string): boolean {
    const doc = this.pool.get(filePath);
    return !!doc && this.seeded.has(doc);
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
    const ahead = await this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      // Something else filled the doc while the caller read the file (a
      // peer's text, say); the read is stale and must not be applied as a
      // change on top of it.
      if (this.seeded.has(doc)) return null;
      this.seeded.add(doc);
      const ytext = doc.getText('content');
      const existing = ytext.toString();
      const base = this._startingPoint(this.savedBase.get(filePath), existing, content);
      this.noteDiskContent(filePath, content);
      this.lastKnownContent.set(filePath, content);

      // A neutral origin ('init'), so the change is not sent out as a local
      // edit. Applied on top of what the doc holds beyond the file, if the
      // doc was ahead of the file when the app last stopped.
      if (base !== content) applyRebasedEdit(ytext, base, content, 'init');

      const merged = ytext.toString();
      return merged !== content ? merged : null;
    });
    // What the doc holds beyond the file still has to be written there.
    if (ahead !== null) await this.onRemoteContentCb?.(filePath, ahead, content);
  }

  /** Record that the file (or its editor) now holds this text. */
  markWritten(filePath: string, content: string, onDisk = false): void {
    this.lastKnownContent.set(filePath, content);
    if (onDisk) this.noteDiskContent(filePath, content);
  }

  /** The text the file or its editor is known to hold, if recorded. */
  getWrittenContent(filePath: string): string | undefined {
    return this.lastKnownContent.get(filePath);
  }

  async getContent(filePath: string): Promise<string> {
    return this._enqueueForPath(filePath, async () => {
      const doc = await this.getOrCreateDoc(filePath);
      return doc.getText('content').toString();
    });
  }

  /**
   * Fingerprint of the note's CRDT history (see docDigest): of the loaded
   * doc if there is one, else of the saved state. Undefined when it has none.
   */
  async crdtDigest(filePath: string): Promise<string | undefined> {
    const doc = this.pool.get(filePath);
    if (doc) return docDigest(doc);
    if (this.pendingDocs.has(filePath)) return undefined;
    return this.persistence.digestOf(filePath);
  }

  async hasDocState(filePath: string): Promise<boolean> {
    if (this.pool.has(filePath)) return true;
    return this.persistence.hasDoc(filePath);
  }

  /** Remove a doc (file was deleted) */
  async removeDoc(filePath: string): Promise<void> {
    await this._enqueueForPath(filePath, async () => {
      this.pool.delete(filePath);
      this.evictedSeeded.delete(filePath);
      this.lastKnownContent.delete(filePath);
      this.diskContent.delete(filePath);
      this.savedBase.delete(filePath);
      await this.persistence.deleteDoc(filePath);
    });
  }

  /**
   * Merge the doc at `fromPath` into the doc at `toPath`, as a local change
   * (so peers get it), when both come from the same history: the same note
   * kept under two paths. Returns the merged text, or null when the
   * histories are unrelated and merging would put both texts in one note.
   */
  async absorbDoc(
    fromPath: string,
    toPath: string,
  ): Promise<{ content: string; previousContent: string } | null> {
    const update = await this._enqueueForPath(fromPath, async () =>
      Y.encodeStateAsUpdate(await this.getOrCreateDoc(fromPath)),
    );
    return this._enqueueForPath(toPath, async () => {
      const doc = await this.getOrCreateDoc(toPath);
      const local = Y.decodeStateVector(Y.encodeStateVector(doc));
      const incoming = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update));
      if (local.size === 0 || incoming.size === 0) return null;
      if (![...incoming.keys()].some((client) => local.has(client))) return null;
      const previousContent = doc.getText('content').toString();
      Y.applyUpdate(doc, update, 'local');
      this.seeded.add(doc);
      await this._commit(toPath, doc);
      return { content: doc.getText('content').toString(), previousContent };
    });
  }

  async renameDoc(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;

    await this._enqueueForPath(oldPath, async () => {
      await this._enqueueForPath(newPath, async () => {
        if (this.pool.has(oldPath)) {
          this.pool.rename(oldPath, newPath);
          const moved = this.pool.peek(newPath);
          if (moved) this.docPaths.set(moved, newPath);
        }
        for (const texts of [this.diskContent, this.savedBase]) {
          const text = texts.get(oldPath);
          texts.delete(oldPath);
          if (text !== undefined) texts.set(newPath, text);
          else texts.delete(newPath);
        }
        this.evictedSeeded.delete(newPath);
        if (this.evictedSeeded.delete(oldPath)) this.evictedSeeded.add(newPath);

        const content = this.lastKnownContent.get(oldPath);
        if (content !== undefined) {
          this.lastKnownContent.set(newPath, content);
          this.lastKnownContent.delete(oldPath);
        }

        await this.persistence.renameDoc(oldPath, newPath);
      });
    });
  }

  /** Save every loaded doc that has unsaved changes. */
  async persistAll(): Promise<void> {
    for (const [path, doc] of this.pool.getAll()) {
      if (this.unchanged.has(doc)) continue;
      await this._enqueueForPath(path, async () => {
        if (this.pool.peek(path) !== doc) return;
        if (!this.unchanged.has(doc)) await this._save(path, doc);
        this._sendHeldUpdates(doc);
      });
    }
    await this.persistence.flushDigests();
  }

  /** Get all tracked file paths */
  getTrackedPaths(): string[] {
    return Array.from(this.pool.getAll().keys());
  }

  async destroy(): Promise<void> {
    await this.pool.destroyAll(async (path, doc) => {
      if (!this.unchanged.has(doc)) await this._save(path, doc);
    });
    await this.persistence.flushDigests();
    this.lastKnownContent.clear();
    this.diskContent.clear();
    this.savedBase.clear();
    this.commitQueued.clear();
  }
}

/**
 * See YjsDocManager.compareHistory. For unrelated histories `localWins`
 * decides, when the caller knows which copy should be kept (the coordinator
 * decides from both files' modification times, which both devices see).
 * Without it the doc whose smallest client ID is lower wins: arbitrary, as
 * client IDs are random, but the same on both sides.
 */
export function compareStateVectors(
  local: Map<number, number>,
  remote: Map<number, number>,
  localWins?: boolean,
): 'related' | 'local-wins' | 'remote-wins' {
  if (local.size === 0 || remote.size === 0) return 'related';
  for (const client of local.keys()) {
    if (remote.has(client)) return 'related';
  }
  if (localWins !== undefined) return localWins ? 'local-wins' : 'remote-wins';
  return Math.min(...local.keys()) < Math.min(...remote.keys())
    ? 'local-wins'
    : 'remote-wins';
}

/**
 * Change a doc's text from `current` to `target`, as a local edit that is
 * sent to peers. Several devices may make the very same change to the very
 * same doc at once (two devices that held the same version of a note each
 * put back the version that won; see SyncCoordinator._settleApartEdits).
 * Deletions made twice are one deletion, but text inserted twice would be
 * there twice. So the edit is made under a client ID derived from the doc's
 * state and the target text: devices making the same change create the same
 * items, which Yjs then holds once. A doc in any other state gets another ID
 * and its own items, as for any edit.
 */
export function restoreText(doc: Y.Doc, current: string, target: string): void {
  const own = doc.clientID;
  const state = Y.encodeSnapshot(Y.snapshot(doc));
  const text = new TextEncoder().encode(target);
  // FNV-1a over the doc's state and the target text.
  let hash = 0x811c9dc5;
  for (const bytes of [state, text]) {
    for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  }
  const shared = (hash >>> 0) || 1;
  // An ID already in the doc would make these items clash with its own.
  if (!Y.decodeStateVector(Y.encodeStateVector(doc)).has(shared)) doc.clientID = shared;
  try {
    applyDiffToYText(doc.getText('content'), current, target);
  } finally {
    doc.clientID = own;
  }
}

/** How many characters differ between two texts. */
function editSize(from: string, to: string): number {
  let size = 0;
  for (const [op, text] of diff(from, to)) {
    if (op !== diff.EQUAL) size += text.length;
  }
  return size;
}

/** Transaction origin for updates received from a peer. */
class RemoteOrigin {
  constructor(readonly deviceId: string) {}
}

function remoteOrigin(deviceId: string | undefined): RemoteOrigin | 'remote' {
  return deviceId ? new RemoteOrigin(deviceId) : 'remote';
}
