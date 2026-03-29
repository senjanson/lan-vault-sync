import { Vault, TFile, TAbstractFile, EventRef } from 'obsidian';
import { FileChangeEvent } from '../types';
import { FileFilter } from './file-filter';
import { DEBOUNCE_MS } from '../constants';
import { logger } from '../logger';

export class VaultWatcher {
  private filter: FileFilter;
  private eventRefs: EventRef[] = [];
  private changeCb: ((event: FileChangeEvent) => void) | null = null;
  private remoteWritePaths = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private vault: Vault, ignoredPaths: string[]) {
    this.filter = new FileFilter(ignoredPaths);
  }

  updateIgnoredPaths(paths: string[]): void {
    this.filter.updateIgnoredPaths(paths);
  }

  onFileChanged(cb: (event: FileChangeEvent) => void): void {
    this.changeCb = cb;
  }

  /** Mark a path as coming from a remote write — next change will be ignored */
  markRemoteWrite(filePath: string): void {
    this.remoteWritePaths.add(filePath);
    // Auto-clear after a generous window to ensure the vault event has fired
    setTimeout(() => this.remoteWritePaths.delete(filePath), 2000);
  }

  start(): void {
    this.eventRefs.push(
      this.vault.on('create', (file) => this._onEvent('create', file)),
      this.vault.on('modify', (file) => this._onEvent('modify', file)),
      this.vault.on('delete', (file) => this._onEvent('delete', file)),
      this.vault.on('rename', (file, oldPath) => this._onEvent('rename', file, oldPath)),
    );
    logger.info('Vault watcher started');
  }

  stop(): void {
    for (const ref of this.eventRefs) {
      this.vault.offref(ref);
    }
    this.eventRefs = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    logger.info('Vault watcher stopped');
  }

  private _onEvent(type: FileChangeEvent['type'], file: TAbstractFile, oldPath?: string): void {
    if (!(file instanceof TFile)) return;

    const path = file.path;

    if (this.filter.shouldIgnore(path)) return;
    if (oldPath && this.filter.shouldIgnore(oldPath)) return;

    // Check if this is a remote write
    if (this.remoteWritePaths.has(path)) {
      this.remoteWritePaths.delete(path);
      logger.debug(`Skipping remote write event: ${path}`);
      return;
    }

    // Debounce modify events
    if (type === 'modify') {
      const existing = this.debounceTimers.get(path);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(path, setTimeout(() => {
        this.debounceTimers.delete(path);
        this._emit(type, path, oldPath);
      }, DEBOUNCE_MS));
    } else {
      this._emit(type, path, oldPath);
    }
  }

  private _emit(type: FileChangeEvent['type'], path: string, oldPath?: string): void {
    const event: FileChangeEvent = {
      type,
      path,
      oldPath,
      isTextFile: this.filter.isTextFile(path),
      timestamp: Date.now(),
    };
    logger.debug(`File event: ${type} ${path}`);
    this.changeCb?.(event);
  }
}
