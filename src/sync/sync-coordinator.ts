import { Vault, TFile } from 'obsidian';
import * as Y from 'yjs';
import { ConnectionManager } from '../transport/connection-manager';
import {
  encodeYjsSync,
  decodeYjsSync,
  encodeFileMetaSync,
  decodeJSON,
} from '../transport/protocol';
import { YjsDocManager } from '../crdt/yjs-doc-manager';
import { ConflictBackupService } from '../conflict/conflict-backup-service';
import { BinaryFileSyncService } from '../binary-sync/binary-sync-service';
import { VaultWatcher } from '../watcher/vault-watcher';
import { DiscoveryService } from '../discovery/discovery-service';
import { FileFilter } from '../watcher/file-filter';
import { SyncStateMachine } from './sync-state';
import { buildFileTree, diffFileTrees } from './file-tree';
import {
  DeviceInfo,
  FileChangeEvent,
  FileMetaSyncPayload,
  LANSyncSettings,
  MessageType,
  SyncState,
} from '../types';
import { logger } from '../logger';
import { ensureParentDirectory } from '../utils/path-utils';

export class SyncCoordinator {
  private connectionManager: ConnectionManager;
  private docManager: YjsDocManager;
  private binarySync: BinaryFileSyncService;
  private backupService: ConflictBackupService;
  private watcher: VaultWatcher;
  private discovery: DiscoveryService;
  private stateMachine: SyncStateMachine;
  private filter: FileFilter;
  private fullSyncTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private pendingInitialBootstrapPeers = new Set<string>();
  private vaultId: string;

  private onStateChangeCb: ((state: SyncState) => void) | null = null;
  private onSyncEventCb: ((msg: string) => void) | null = null;

  constructor(
    private vault: Vault,
    private settings: LANSyncSettings,
  ) {
    // Generate a vault ID from the vault name
    this.vaultId = this._hashVaultId(vault.getName());

    this.filter = new FileFilter(settings.ignoredPaths);
    this.stateMachine = new SyncStateMachine();
    this.connectionManager = new ConnectionManager(settings, this.vaultId);
    this.docManager = new YjsDocManager(vault);
    this.backupService = new ConflictBackupService(vault);
    this.binarySync = new BinaryFileSyncService(vault, this.connectionManager, this.backupService);
    this.watcher = new VaultWatcher(vault, settings.ignoredPaths);

    const localDevice: DeviceInfo = {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      ip: '',
      port: settings.port,
      vaultId: this.vaultId,
      lastSeen: Date.now(),
    };
    this.discovery = new DiscoveryService(localDevice);

    this._wireCallbacks();
  }

  onStateChange(cb: (state: SyncState) => void): void {
    this.onStateChangeCb = cb;
  }

  onSyncEvent(cb: (msg: string) => void): void {
    this.onSyncEventCb = cb;
  }

  getState(): SyncState {
    return this.stateMachine.getState();
  }

  getConnectedDevices(): string[] {
    return this.connectionManager.getConnectedPeerIds();
  }

  getDiscoveredDevices(): DeviceInfo[] {
    return this.discovery.getOnlineDevices();
  }

  async start(): Promise<void> {
    if (!this.settings.enabled) return;

    try {
      this.stateMachine.transition('discovering');

      // Start WebSocket server
      await this.connectionManager.start();

      // Start device discovery
      await this.discovery.start();

      // Connect to manual peers
      for (const addr of this.settings.manualPeers) {
        this.discovery.addManualPeer(addr, this.vaultId);
      }

      // Start watching vault
      this.watcher.start();

      // Start periodic full sync
      if (this.settings.syncIntervalMs > 0) {
        this.fullSyncTimer = setInterval(
          () => this._periodicFullSync(),
          this.settings.syncIntervalMs,
        );
      }

      // Periodically persist CRDT state
      this.persistTimer = setInterval(
        () => this.docManager.persistAll(),
        60000, // every 60 seconds
      );

      this.stateMachine.transition('watching');
      this._emitEvent('Sync service started');
    } catch (err) {
      logger.error('Failed to start sync:', err);
      this.stateMachine.transition('error');
    }
  }

  async stop(): Promise<void> {
    if (this.fullSyncTimer) {
      clearInterval(this.fullSyncTimer);
      this.fullSyncTimer = null;
    }
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }

    this.watcher.stop();
    this.discovery.stop();
    this.connectionManager.stop();
    await this.docManager.persistAll();
    await this.docManager.destroy();

    this.stateMachine.transition('idle');
    this._emitEvent('Sync service stopped');
  }

  addManualPeer(address: string): void {
    this.discovery.addManualPeer(address, this.vaultId);
  }

  // ─── Private: Wire up callbacks ─────────────────────────

  private _wireCallbacks(): void {
    // State machine changes
    this.stateMachine.onStateChange((_from, to) => {
      this.onStateChangeCb?.(to);
    });

    // Device discovered → connect
    this.discovery.onDeviceFound((device) => {
      this._emitEvent(`Device found: ${device.deviceName}`);
      this.connectionManager.connectToPeer(device);
    });

    this.discovery.onDeviceLost((device) => {
      this._emitEvent(`Device lost: ${device.deviceName}`);
    });

    // Peer connected → initial sync
    this.connectionManager.onPeerConnected(async (device) => {
      this._emitEvent(`Connected to ${device.deviceId}`);
      this.pendingInitialBootstrapPeers.add(device.deviceId);
      await this._initialSyncWith(device.deviceId);
    });

    this.connectionManager.onPeerDisconnected((deviceId) => {
      this.pendingInitialBootstrapPeers.delete(deviceId);
      this._emitEvent(`Disconnected: ${deviceId}`);
    });

    // Incoming protocol messages
    this.connectionManager.onMessage(async (deviceId, type, payload) => {
      await this._handleMessage(deviceId, type, payload);
    });

    // Vault watcher → local changes
    this.watcher.onFileChanged(async (event) => {
      await this._handleLocalFileChange(event);
    });

    // Yjs doc manager → broadcast local updates
    this.docManager.onLocalUpdate((filePath, update) => {
      const msg = encodeYjsSync(MessageType.YJS_UPDATE, filePath, update);
      this.connectionManager.broadcast(msg);
    });

    // Yjs doc manager → remote content changed, write to file
    this.docManager.onRemoteContent(async (filePath, content, previousContent) => {
      await this._writeFileFromRemote(filePath, content, previousContent);
    });

    // Binary sync → mark remote writes
    this.binarySync.onRemoteFileWritten((path) => {
      this.watcher.markRemoteWrite(path);
    });
  }

  // ─── Private: Message handling ──────────────────────────

  private async _handleMessage(deviceId: string, type: MessageType, payload: Uint8Array): Promise<void> {
    switch (type) {
      case MessageType.YJS_SYNC_STEP1: {
        const msg = decodeYjsSync(payload);
        if (!this._isSafePath(msg.filePath)) break;
        await this._flushPendingLocalTextChange(msg.filePath);
        // Ensure the local doc is seeded from disk so we don't respond with an
        // empty state when we have content the remote peer hasn't seen yet.
        await this._ensureCrdtInitialized(msg.filePath);
        const response = await this.docManager.handleSyncStep1(msg.filePath, msg.data);
        const reply = encodeYjsSync(MessageType.YJS_SYNC_STEP2, msg.filePath, response);
        this.connectionManager.sendTo(deviceId, reply);
        break;
      }

      case MessageType.YJS_SYNC_STEP2: {
        const msg = decodeYjsSync(payload);
        if (!this._isSafePath(msg.filePath)) break;
        await this._flushPendingLocalTextChange(msg.filePath);
        await this.docManager.handleSyncStep2(msg.filePath, msg.data);
        break;
      }

      case MessageType.YJS_UPDATE: {
        const msg = decodeYjsSync(payload);
        if (!this._isSafePath(msg.filePath)) break;
        await this._flushPendingLocalTextChange(msg.filePath);
        await this.docManager.applyRemoteUpdate(msg.filePath, msg.data);
        break;
      }

      case MessageType.FILE_META_SYNC: {
        const meta = decodeJSON<FileMetaSyncPayload>(payload);
        await this._handleRemoteFileTree(deviceId, meta);
        break;
      }

      case MessageType.FILE_REQUEST:
      case MessageType.FILE_DATA:
      case MessageType.FILE_DELETE:
      case MessageType.FILE_RENAME:
        await this.binarySync.handleMessage(deviceId, type, payload);
        break;
    }
  }

  // ─── Private: Local file changes ────────────────────────

  private async _handleLocalFileChange(event: FileChangeEvent): Promise<void> {
    const { type, path, oldPath, isTextFile } = event;

    switch (type) {
      case 'create':
      case 'modify': {
        if (isTextFile) {
          const file = this.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            const content = await this.vault.cachedRead(file);
            await this.docManager.applyLocalChange(path, content);
          }
        } else {
          await this.binarySync.broadcastFileChange(path);
        }
        break;
      }

      case 'delete': {
        if (isTextFile) {
          await this.docManager.removeDoc(path);
        }
        this.binarySync.broadcastFileDelete(path);
        break;
      }

      case 'rename': {
        if (oldPath && isTextFile) {
          await this.docManager.removeDoc(oldPath);
        }
        if (oldPath) {
          this.binarySync.broadcastFileRename(oldPath, path);
        }
        break;
      }
    }
  }

  // ─── Private: Write remote content to file ──────────────

  private async _writeFileFromRemote(
    filePath: string,
    content: string,
    previousContent?: string,
  ): Promise<void> {
    try {
      if (!this._isSafePath(filePath)) {
        logger.warn(`Rejected unsafe remote path: ${filePath}`);
        return;
      }
      await this._flushPendingLocalTextChange(filePath);
      const latestContent = await this.docManager.getContent(filePath).catch(() => content);
      const file = this.vault.getAbstractFileByPath(filePath);

      if (file instanceof TFile && typeof previousContent === 'string') {
        const diskContent = await this.vault.cachedRead(file);
        if (
          diskContent !== previousContent &&
          diskContent !== latestContent
        ) {
          const backup = await this.backupService.backupTextFile(
            filePath,
            diskContent,
            'text-remote-overwrite',
            {
              previousContent,
              mergedContent: latestContent,
            },
          );
          if (backup) {
            logger.warn(`Backed up divergent text file before remote write: ${filePath} -> ${backup.contentPath}`);
            this._emitEvent(`Conflict backup created for ${filePath}`);
          }
        }
      }

      this.watcher.markRemoteWrite(filePath);

      if (file instanceof TFile) {
        await this.vault.modify(file, latestContent);
      } else {
        const adapter = (this.vault as any).adapter;
        if (adapter) {
          await ensureParentDirectory(adapter, filePath);
        }
        await this.vault.create(filePath, latestContent);
        this.watcher.markRemoteWrite(filePath);
      }
    } catch (err) {
      logger.error(`Failed to write remote content to ${filePath}:`, err);
    }
  }

  // ─── Private: Initial sync ──────────────────────────────

  private async _initialSyncWith(deviceId: string): Promise<void> {
    this.stateMachine.transition('initial-sync');
    this._emitEvent(`Starting initial sync with ${deviceId}`);

    try {
      // Only exchange file tree metadata — NO CRDT initialization here.
      // CRDT docs are created lazily on first edit after initial sync.
      // This avoids the dual-initialization bug where both sides insert
      // the full file content into independent Y.Docs, causing duplicated
      // text when the docs are synced.
      const tree = await buildFileTree(this.vault, this.filter);
      const metaList = Array.from(tree.files.values());
      const msg = encodeFileMetaSync({ files: metaList });
      this.connectionManager.sendTo(deviceId, msg);

      this.stateMachine.transition('watching');
      this._emitEvent(`File tree sent to ${deviceId}, waiting for remote tree`);
    } catch (err) {
      logger.error('Initial sync failed:', err);
      this.stateMachine.transition('error');
    }
  }

  // ─── Private: Handle remote file tree ───────────────────

  private async _handleRemoteFileTree(deviceId: string, meta: FileMetaSyncPayload): Promise<void> {
    const localTree = await buildFileTree(this.vault, this.filter);
    const isInitialBootstrap = this.pendingInitialBootstrapPeers.has(deviceId);
    const remoteFiles = new Map<string, typeof meta.files[number]>();
    for (const f of meta.files) {
      remoteFiles.set(f.path, f);
    }

    const treeDiff = diffFileTrees(localTree.files, remoteFiles);

    // Files only on remote — request them (file-level transfer for both text & binary)
    for (const file of treeDiff.remoteOnly) {
      if (file.isTextFile) {
        await this.docManager.removeDoc(file.path);
        const emptyState = Y.encodeStateVector(new Y.Doc());
        const msg = encodeYjsSync(MessageType.YJS_SYNC_STEP1, file.path, emptyState);
        this.connectionManager.sendTo(deviceId, msg);
        this._emitEvent(`Requesting text state: ${file.path}`);
      } else {
        this.binarySync.requestFile(deviceId, file.path);
        this._emitEvent(`Requesting: ${file.path}`);
      }
    }

    // Files only locally — send them to the specific peer
    for (const file of treeDiff.localOnly) {
      if (file.isTextFile) {
        await this._sendFullTextState(deviceId, file.path, 'Sending text state');
      } else {
        await this.binarySync.sendFileToPeer(deviceId, file.path);
        this._emitEvent(`Sending: ${file.path}`);
      }
    }

    // Conflicting files (different hash).
    // For text files use CRDT sync so both sides' edits are merged without
    // losing data.  For binary files fall back to mtime-based winner selection.
    for (const { local, remote } of treeDiff.conflicting) {
      if (local.isTextFile) {
        await this._flushPendingLocalTextChange(local.path);
        // Seed the local CRDT doc from disk (silently — no broadcast yet).
        await this._ensureCrdtInitialized(local.path);
        // Send sync step 1 — the peer will respond with its content diff and
        // both sides will converge on the CRDT-merged result.
        const stateVector = await this.docManager.encodeSyncStep1(local.path);
        const msg = encodeYjsSync(MessageType.YJS_SYNC_STEP1, local.path, stateVector);
        this.connectionManager.sendTo(deviceId, msg);
        this._emitEvent(`CRDT merge conflict: ${local.path}`);
      } else {
        if (remote.mtime > local.mtime) {
          // Remote is newer — request it
          this.binarySync.requestFile(deviceId, remote.path);
          this._emitEvent(`Requesting newer binary: ${remote.path}`);
        } else {
          // Local is newer (or same mtime) — send ours
          await this.binarySync.sendFileToPeer(deviceId, local.path);
          this._emitEvent(`Sending newer binary: ${local.path}`);
        }
      }
    }

    if (isInitialBootstrap) {
      for (const [path, local] of localTree.files) {
        const remote = remoteFiles.get(path);
        if (!remote || !local.isTextFile) continue;
        if (local.hash !== remote.hash) continue;
        if (!this._shouldBootstrapSharedTextState(deviceId)) continue;

        await this._sendFullTextState(deviceId, path, 'Bootstrapping shared text state');
      }

      this.pendingInitialBootstrapPeers.delete(deviceId);
    }

    this._emitEvent(`Tree sync with ${deviceId}: +${treeDiff.remoteOnly.length} -0 ~${treeDiff.conflicting.length}`);
  }

  // ─── Private: CRDT initialization helper ─────────────────

  /**
   * If no CRDT doc is active for filePath yet, load the current file content
   * from disk into a new doc WITHOUT broadcasting it as a local update.
   * This is used to prime docs before a Yjs sync exchange so that the peer
   * receives our actual content, not an empty state.
   */
  private async _ensureCrdtInitialized(filePath: string): Promise<void> {
    if (this.docManager.isDocActive(filePath)) return;
    const file = this.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    const content = await this.vault.cachedRead(file);
    await this.docManager.initDocFromContentSilent(filePath, content);
  }

  private async _sendFullTextState(deviceId: string, filePath: string, eventPrefix: string): Promise<void> {
    await this._flushPendingLocalTextChange(filePath);
    await this._ensureCrdtInitialized(filePath);
    const update = await this.docManager.encodeFullState(filePath);
    const msg = encodeYjsSync(MessageType.YJS_UPDATE, filePath, update);
    this.connectionManager.sendTo(deviceId, msg);
    this._emitEvent(`${eventPrefix}: ${filePath}`);
  }

  /**
   * If a local modify is still sitting in the debounce queue, ingest the
   * current on-disk content into Yjs before we process a remote update.
   */
  private async _flushPendingLocalTextChange(filePath: string): Promise<boolean> {
    if (!this.watcher.consumePendingModify(filePath)) {
      return false;
    }

    const file = this.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      return false;
    }

    const content = await this.vault.cachedRead(file);
    await this.docManager.applyLocalChange(filePath, content);
    return true;
  }

  // ─── Private: Periodic full sync ────────────────────────

  private async _periodicFullSync(): Promise<void> {
    const peers = this.connectionManager.getConnectedPeerIds();
    if (peers.length === 0) return;

    // Re-send file tree metadata to trigger tree diff on peers
    const tree = await buildFileTree(this.vault, this.filter);
    const metaList = Array.from(tree.files.values());
    const msg = encodeFileMetaSync({ files: metaList });

    for (const peerId of peers) {
      this.connectionManager.sendTo(peerId, msg);
    }
  }

  // ─── Private: Helpers ───────────────────────────────────

  private _hashVaultId(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      const char = name.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return 'vault-' + Math.abs(hash).toString(36);
  }

  private _emitEvent(msg: string): void {
    logger.info(msg);
    this.onSyncEventCb?.(msg);
  }

  private _shouldBootstrapSharedTextState(deviceId: string): boolean {
    return this.settings.deviceId <= deviceId;
  }

  /** Validate that a path from a remote peer is safe (no traversal) */
  private _isSafePath(filePath: string): boolean {
    if (!filePath) return false;
    // Reject absolute paths, traversal, and null bytes
    if (filePath.startsWith('/') || filePath.startsWith('\\')) return false;
    if (filePath.includes('..')) return false;
    if (filePath.includes('\0')) return false;
    return true;
  }
}
