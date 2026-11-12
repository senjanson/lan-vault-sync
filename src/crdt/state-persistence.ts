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

export class StatePersistence {
  private digests: Map<string, [string, string]> | null = null;
  private digestsLoading: Promise<Map<string, [string, string]>> | null = null;
  private digestsDirty = false;

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
    const bytes = new TextEncoder().encode(filePath);
    const hash = await computeFileHash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    return `${CRDT_STATE_DIR}/${hash}.ystate`;
  }

  private _legacyStateFilePath(filePath: string): string {
    return `${CRDT_STATE_DIR}/${this._legacyKeyForPath(filePath)}.ystate`;
  }

  private async _exists(path: string): Promise<boolean> {
    try {
      return await this.adapter.exists(path);
    } catch {
      return false; // e.g. a legacy name that is too long for the file system
    }
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

  async saveDoc(filePath: string, doc: Y.Doc): Promise<void> {
    try {
      const state = Y.encodeStateAsUpdate(doc);
      const stateFile = await this._stateFilePath(filePath);
      await ensureParentDirectory(this.adapter, stateFile);

      await this.adapter.writeBinary(stateFile, state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength));
      await this._removeIfExists(this._legacyStateFilePath(filePath));
      const digest = await docDigest(doc);
      await this._setDigest(filePath, digest ? [stateFile, digest] : null);
    } catch (err) {
      logger.error(`Failed to save CRDT state for ${filePath}:`, err);
    }
  }

  async loadDoc(filePath: string, doc: Y.Doc): Promise<boolean> {
    try {
      const stateFile = await this._existingStateFile(filePath);
      if (stateFile) {
        const buffer: ArrayBuffer = await this.adapter.readBinary(stateFile);
        const update = new Uint8Array(buffer);
        Y.applyUpdate(doc, update);
        if (stateFile === (await this._stateFilePath(filePath))) {
          const digest = await docDigest(doc);
          await this._setDigest(filePath, digest ? [stateFile, digest] : null);
        }
        return true;
      }
    } catch (err) {
      logger.error(`Failed to load CRDT state for ${filePath}:`, err);
    }
    return false;
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
      } else {
        const buffer: ArrayBuffer = await this.adapter.readBinary(oldStateFile);
        await this.adapter.writeBinary(newStateFile, buffer);
        await this._removeIfExists(oldStateFile);
      }
      if (moved && moved[0] === oldStateFile) await this._setDigest(newPath, [newStateFile, moved[1]]);
    } catch (err) {
      logger.error(`Failed to rename CRDT state from ${oldPath} to ${newPath}:`, err);
    }
  }

  private async _removeIfExists(path: string): Promise<void> {
    if (typeof this.adapter.remove !== 'function') return;
    if (await this._exists(path)) {
      await this.adapter.remove(path);
    }
  }
}
