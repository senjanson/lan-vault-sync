import { Vault } from 'obsidian';
import * as Y from 'yjs';
import { CRDT_STATE_DIR } from '../constants';
import { logger } from '../logger';

/**
 * Persist / restore Yjs doc state to the vault's plugin data directory.
 * Each doc is saved as a binary file: crdt-state/<base64(path)>.ystate
 */
export class StatePersistence {
  constructor(private vault: Vault, private adapter: any) {}

  private _keyForPath(filePath: string): string {
    // Use base64url-safe encoding of the file path
    return btoa(filePath).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private _stateFilePath(filePath: string): string {
    return `${CRDT_STATE_DIR}/${this._keyForPath(filePath)}.ystate`;
  }

  async saveDoc(filePath: string, doc: Y.Doc): Promise<void> {
    try {
      const state = Y.encodeStateAsUpdate(doc);
      const stateFile = this._stateFilePath(filePath);

      // Ensure directory exists
      const dir = stateFile.substring(0, stateFile.lastIndexOf('/'));
      if (!(await this.adapter.exists(dir))) {
        await this.adapter.mkdir(dir);
      }

      await this.adapter.writeBinary(stateFile, state.buffer);
    } catch (err) {
      logger.error(`Failed to save CRDT state for ${filePath}:`, err);
    }
  }

  async loadDoc(filePath: string, doc: Y.Doc): Promise<boolean> {
    try {
      const stateFile = this._stateFilePath(filePath);
      if (await this.adapter.exists(stateFile)) {
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
      const stateFile = this._stateFilePath(filePath);
      if (await this.adapter.exists(stateFile)) {
        await this.adapter.remove(stateFile);
      }
    } catch (err) {
      logger.error(`Failed to delete CRDT state for ${filePath}:`, err);
    }
  }
}
