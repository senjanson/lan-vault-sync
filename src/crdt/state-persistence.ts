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
export class StatePersistence {
  constructor(private vault: Vault, private adapter: any) {}

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
        return true;
      }
    } catch (err) {
      logger.error(`Failed to load CRDT state for ${filePath}:`, err);
    }
    return false;
  }

  async deleteDoc(filePath: string): Promise<void> {
    try {
      await this._removeIfExists(await this._stateFilePath(filePath));
      await this._removeIfExists(this._legacyStateFilePath(filePath));
    } catch (err) {
      logger.error(`Failed to delete CRDT state for ${filePath}:`, err);
    }
  }

  async renameDoc(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;

    try {
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
        return;
      }

      const buffer: ArrayBuffer = await this.adapter.readBinary(oldStateFile);
      await this.adapter.writeBinary(newStateFile, buffer);
      await this._removeIfExists(oldStateFile);
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
