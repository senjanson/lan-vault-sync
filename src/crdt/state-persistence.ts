import { Vault } from 'obsidian';
import * as Y from 'yjs';
import { CRDT_STATE_DIR } from '../constants';
import { logger } from '../logger';
import { ensureParentDirectory } from '../utils/path-utils';
import { computeFileHash } from '../binary-sync/file-hash';

/**
 * Persist / restore Yjs doc state to the vault's plugin data directory.
 * Each doc is saved as crdt-state/<sha256(path)>.ystate. The hash keeps file
 * names short; the former base64(path) names exceeded the 255-byte file name
 * limit for long (especially CJK) paths, so their state was never saved.
 * Files with the former names are still read and migrated on save.
 */
/** Saved alongside the states: path -> [state file, digest of its doc]. */
const DIGEST_INDEX = `${CRDT_STATE_DIR}/digests.json`;

/**
 * A short fingerprint of a doc's history: its state vector and delete set,
 * which Yjs encodes the same way on every device. Two devices with the same
 * digest hold the same doc, so they need not send it to each other.
 */
export async function docDigest(doc: Y.Doc): Promise<string | undefined> {
  if (doc.store.clients.size === 0) return undefined;
  const bytes = Y.encodeSnapshot(Y.snapshot(doc));
  const hash = await computeFileHash(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return hash.slice(0, 32);
}

/**
 * A state file normally holds just the doc's Yjs update. While the doc holds
 * text that is not in the note's file yet, the file's text is saved in front
 * of it, after this marker; see YjsDocManager.diskContent. A Yjs update
 * cannot start with these bytes: they would be an absurd struct count.
 */
const BASE_MARKER = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x4c, 0x56, 0x53, 0x02]);

function encodeState(update: Uint8Array, base: string | undefined): Uint8Array {
  if (base === undefined) return update;
  const text = new TextEncoder().encode(base);
  const out = new Uint8Array(BASE_MARKER.length + 4 + text.length + update.length);
  out.set(BASE_MARKER, 0);
  new DataView(out.buffer).setUint32(BASE_MARKER.length, text.length);
  out.set(text, BASE_MARKER.length + 4);
  out.set(update, BASE_MARKER.length + 4 + text.length);
  return out;
}

function decodeState(bytes: Uint8Array): { update: Uint8Array; base?: string } {
  if (bytes.length < BASE_MARKER.length + 4) return { update: bytes };
  for (let i = 0; i < BASE_MARKER.length; i++) {
    if (bytes[i] !== BASE_MARKER[i]) return { update: bytes };
  }
  const start = BASE_MARKER.length + 4;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(BASE_MARKER.length);
  if (start + length > bytes.length) throw new Error('truncated CRDT state file');
  return {
    base: new TextDecoder().decode(bytes.subarray(start, start + length)),
    update: bytes.subarray(start + length),
  };
}

export class StatePersistence {
  private digests: Map<string, [string, string]> | null = null;
  private digestsLoading: Promise<Map<string, [string, string]>> | null = null;
  private digestsDirty = false;
  /**
   * State file names by path, and the paths known to have no file under
   * their former name. A note is saved after every change, so a save must
   * not hash its path and look for the former file each time.
   */
  private stateFiles = new Map<string, string>();
  private noLegacyFile = new Set<string>();
  private stateDirReady = false;
  /**
   * The state files on disk, listed once and then kept up to date here, so
   * that finding out whether a note has a saved history needs no file system
   * lookup: on a phone each lookup is a round trip, and notes arriving or
   * deleted in bulk asked several times per note. Null until listed, or when
   * the folder cannot be listed. Changes made before the listing is in are
   * replayed on it.
   */
  private listedStates: Set<string> | null = null;
  private listingStates: Promise<Set<string> | null> | null = null;
  private stateChangesWhileListing: Array<[string, boolean]> | null = [];

  constructor(private vault: Vault, private adapter: any) {}

  /** The digest of the saved history of a note, if it has one. */
  async digestOf(filePath: string): Promise<string | undefined> {
    return (await this._digestIndex()).get(filePath)?.[1];
  }

  /** Write the digest index if it changed. */
  async flushDigests(): Promise<void> {
    if (!this.digests || !this.digestsDirty) return;
    this.digestsDirty = false;
    try {
      await ensureParentDirectory(this.adapter, DIGEST_INDEX);
      await this.adapter.write(DIGEST_INDEX, JSON.stringify(Object.fromEntries(this.digests)));
    } catch (err) {
      this.digestsDirty = true;
      logger.error('Failed to save CRDT digests:', err);
    }
  }

  /**
   * Load the index, keeping only entries whose state file still exists. An
   * entry can outlive its file if the app stopped before the index was
   * written; a digest without the history behind it must never be reported.
   * An entry can also be older than its file, which only means a note is
   * sent again.
   */
  private _digestIndex(): Promise<Map<string, [string, string]>> {
    if (this.digests) return Promise.resolve(this.digests);
    if (!this.digestsLoading) {
      this.digestsLoading = (async () => {
        const index = new Map<string, [string, string]>();
        try {
          if (await this._exists(DIGEST_INDEX)) {
            const saved = JSON.parse(await this.adapter.read(DIGEST_INDEX)) as Record<string, [string, string]>;
            const listed = await this.adapter.list(CRDT_STATE_DIR);
            const files = new Set<string>(listed?.files ?? []);
            for (const [path, entry] of Object.entries(saved)) {
              if (Array.isArray(entry) && files.has(entry[0])) index.set(path, entry);
            }
          }
        } catch (err) {
          logger.warn('Ignoring unreadable CRDT digests:', err);
        }
        // Entries recorded while the index was loading are newer.
        if (this.digests) for (const [k, v] of this.digests) index.set(k, v);
        this.digests = index;
        return index;
      })();
    }
    return this.digestsLoading;
  }

  private async _setDigest(filePath: string, entry: [string, string] | null): Promise<void> {
    const index = await this._digestIndex();
    const old = index.get(filePath);
    if (entry) {
      if (old && old[0] === entry[0] && old[1] === entry[1]) return;
      index.set(filePath, entry);
    } else {
      if (!old) return;
      index.delete(filePath);
    }
    this.digestsDirty = true;
  }

  private _legacyKeyForPath(filePath: string): string {
    const bytes = new TextEncoder().encode(filePath);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private async _stateFilePath(filePath: string): Promise<string> {
    const known = this.stateFiles.get(filePath);
    if (known) return known;
    const bytes = new TextEncoder().encode(filePath);
    const hash = await computeFileHash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const stateFile = `${CRDT_STATE_DIR}/${hash}.ystate`;
    if (this.stateFiles.size >= 5000) this.stateFiles.clear();
    this.stateFiles.set(filePath, stateFile);
    return stateFile;
  }

  private async _removeLegacyFile(filePath: string): Promise<void> {
    if (this.noLegacyFile.has(filePath)) return;
    await this._removeIfExists(this._legacyStateFilePath(filePath));
    if (this.noLegacyFile.size >= 5000) this.noLegacyFile.clear();
    this.noLegacyFile.add(filePath);
  }

  private _legacyStateFilePath(filePath: string): string {
    return `${CRDT_STATE_DIR}/${this._legacyKeyForPath(filePath)}.ystate`;
  }

  private async _exists(path: string): Promise<boolean> {
    if (this._isStateFile(path)) {
      const listed = await this._listStates();
      if (listed) return listed.has(path);
    }
    try {
      return await this.adapter.exists(path);
    } catch {
      return false; // e.g. a legacy name that is too long for the file system
    }
  }

  private _isStateFile(path: string): boolean {
    return path.startsWith(`${CRDT_STATE_DIR}/`) && path.endsWith('.ystate');
  }

  private _listStates(): Promise<Set<string> | null> {
    if (!this.listingStates) {
      this.listingStates = (async () => {
        let listed: Set<string> | null = null;
        try {
          if (typeof this.adapter.list === 'function') {
            listed = (await this.adapter.exists(CRDT_STATE_DIR))
              ? new Set<string>(((await this.adapter.list(CRDT_STATE_DIR))?.files ?? []).filter((f: string) => this._isStateFile(f)))
              : new Set<string>();
          }
        } catch (err) {
          logger.debug('Could not list CRDT states; looking each one up:', err);
          listed = null;
        }
        if (listed) for (const [path, present] of this.stateChangesWhileListing ?? []) this._apply(listed, path, present);
        this.stateChangesWhileListing = null;
        this.listedStates = listed;
        return listed;
      })();
    }
    return this.listingStates;
  }

  /** Record that a state file was written (present) or removed. */
  private _noteState(path: string, present: boolean): void {
    if (this.listedStates) this._apply(this.listedStates, path, present);
    else this.stateChangesWhileListing?.push([path, present]);
  }

  private _apply(listed: Set<string>, path: string, present: boolean): void {
    if (present) listed.add(path);
    else listed.delete(path);
  }

  /** The state file that currently holds this path's state, if any. */
  private async _existingStateFile(filePath: string): Promise<string | null> {
    const current = await this._stateFilePath(filePath);
    if (await this._exists(current)) return current;
    const legacy = this._legacyStateFilePath(filePath);
    if (await this._exists(legacy)) return legacy;
    return null;
  }

  async hasDoc(filePath: string): Promise<boolean> {
    try {
      return (await this._existingStateFile(filePath)) !== null;
    } catch (err) {
      logger.error(`Failed to check CRDT state for ${filePath}:`, err);
      return false;
    }
  }

  /**
   * Save a doc's state; `base` is the text of the note's file when that
   * differs from the doc's (see BASE_MARKER). Returns false if it failed.
   */
  async saveDoc(filePath: string, doc: Y.Doc, base?: string): Promise<boolean> {
    try {
      const state = encodeState(Y.encodeStateAsUpdate(doc), base);
      const stateFile = await this._stateFilePath(filePath);
      if (!this.stateDirReady) {
        await ensureParentDirectory(this.adapter, stateFile);
        this.stateDirReady = true;
      }

      await this.adapter.writeBinary(stateFile, state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength));
      this._noteState(stateFile, true);
      await this._removeLegacyFile(filePath);
      const digest = await docDigest(doc);
      await this._setDigest(filePath, digest ? [stateFile, digest] : null);
      return true;
    } catch (err) {
      this.stateDirReady = false;
      logger.error(`Failed to save CRDT state for ${filePath}:`, err);
      return false;
    }
  }

  async loadDoc(filePath: string, doc: Y.Doc): Promise<boolean> {
    return (await this.loadState(filePath, doc)) !== null;
  }

  /**
   * Load a doc's saved state, if it has one. `base` is the text the note's
   * file held when the state was saved, if it was not the doc's text.
   */
  async loadState(filePath: string, doc: Y.Doc): Promise<{ base?: string } | null> {
    try {
      const stateFile = await this._existingStateFile(filePath);
      if (stateFile) {
        const buffer: ArrayBuffer = await this.adapter.readBinary(stateFile);
        const { update, base } = decodeState(new Uint8Array(buffer));
        Y.applyUpdate(doc, update);
        if (stateFile === (await this._stateFilePath(filePath))) {
          const digest = await docDigest(doc);
          await this._setDigest(filePath, digest ? [stateFile, digest] : null);
        }
        return { base };
      }
    } catch (err) {
      logger.error(`Failed to load CRDT state for ${filePath}:`, err);
    }
    return null;
  }

  async deleteDoc(filePath: string): Promise<void> {
    try {
      await this._setDigest(filePath, null);
      await this._removeIfExists(await this._stateFilePath(filePath));
      await this._removeIfExists(this._legacyStateFilePath(filePath));
    } catch (err) {
      logger.error(`Failed to delete CRDT state for ${filePath}:`, err);
    }
  }

  async renameDoc(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;

    try {
      const moved = (await this._digestIndex()).get(oldPath);
      await this._setDigest(oldPath, null);
      await this._setDigest(newPath, null);
      const oldStateFile = await this._existingStateFile(oldPath);
      if (!oldStateFile) {
        return;
      }

      const newStateFile = await this._stateFilePath(newPath);
      await ensureParentDirectory(this.adapter, newStateFile);
      await this._removeIfExists(newStateFile);
      await this._removeIfExists(this._legacyStateFilePath(newPath));

      if (typeof this.adapter.rename === 'function') {
        await this.adapter.rename(oldStateFile, newStateFile);
        this._noteState(oldStateFile, false);
      } else {
        const buffer: ArrayBuffer = await this.adapter.readBinary(oldStateFile);
        await this.adapter.writeBinary(newStateFile, buffer);
        await this._removeIfExists(oldStateFile);
      }
      this._noteState(newStateFile, true);
      if (moved && moved[0] === oldStateFile) await this._setDigest(newPath, [newStateFile, moved[1]]);
    } catch (err) {
      logger.error(`Failed to rename CRDT state from ${oldPath} to ${newPath}:`, err);
    }
  }

  private async _removeIfExists(path: string): Promise<void> {
    if (typeof this.adapter.remove !== 'function') return;
    if (await this._exists(path)) {
      await this.adapter.remove(path);
      this._noteState(path, false);
    }
  }
}
