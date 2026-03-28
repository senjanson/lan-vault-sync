import { Vault, TFile } from 'obsidian';
import { ConnectionManager } from '../transport/connection-manager';
import {
  encodeYjsSync,
  decodeYjsSync,
  encodeFileMetaSync,
  decodeJSON,
} from '../transport/protocol';
import { YjsDocManager } from '../crdt/yjs-doc-manager';
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
  private watcher: VaultWatcher;
  private discovery: DiscoveryService;
  private stateMachine: SyncStateMachine;
  private filter: FileFilter;
  private fullSyncTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
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
    this.binarySync = new BinaryFileSyncService(vault, this.connectionManager);
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
      await this._initialSyncWith(device.deviceId);
    });

    this.connectionManager.onPeerDisconnected((deviceId) => {
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
    this.docManager.onRemoteContent(async (filePath, content) => {
      await this._writeFileFromRemote(filePath, content);
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
        const response = await this.docManager.handleSyncStep1(msg.filePath, msg.data);
        const reply = encodeYjsSync(MessageType.YJS_SYNC_STEP2, msg.filePath, response);
        this.connectionManager.sendTo(deviceId, reply);
        break;
      }

      case MessageType.YJS_SYNC_STEP2: {
        const msg = decodeYjsSync(payload);
        if (!this._isSafePath(msg.filePath)) break;
        await this.docManager.handleSyncStep2(msg.filePath, msg.data);
        break;
      }

      case MessageType.YJS_UPDATE: {
        const msg = decodeYjsSync(payload);
        if (!this._isSafePath(msg.filePath)) break;
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
          // Initialize new doc with current content
          const file = this.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            const content = await this.vault.cachedRead(file);
            await this.docManager.initDocWithContent(path, content);
          }
        }
        if (oldPath) {
          this.binarySync.broadcastFileRename(oldPath, path);
        }
        break;
      }
    }
  }

  // ─── Private: Write remote content to file ──────────────

  private async _writeFileFromRemote(filePath: string, content: string): Promise<void> {
    try {
      if (!this._isSafePath(filePath)) {
        logger.warn(`Rejected unsafe remote path: ${filePath}`);
        return;
      }
      this.watcher.markRemoteWrite(filePath);
      const file = this.vault.getAbstractFileByPath(filePath);

      if (file instanceof TFile) {
        await this.vault.modify(file, content);
      } else {
        const adapter = (this.vault as any).adapter;
        if (adapter) {
          await ensureParentDirectory(adapter, filePath);
        }
        await this.vault.create(filePath, content);
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
      // Send our file tree metadata
      const tree = await buildFileTree(this.vault, this.filter);
      const metaList = Array.from(tree.files.values());
      const msg = encodeFileMetaSync({ files: metaList });
      this.connectionManager.sendTo(deviceId, msg);

      // For each text file, initiate Yjs sync
      for (const [path, meta] of tree.files) {
        if (meta.isTextFile) {
          const file = this.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            const content = await this.vault.cachedRead(file);
            await this.docManager.initDocWithContent(path, content);
          }

          // Send sync step 1
          const syncData = await this.docManager.encodeSyncStep1(path);
          const syncMsg = encodeYjsSync(MessageType.YJS_SYNC_STEP1, path, syncData);
          this.connectionManager.sendTo(deviceId, syncMsg);
        }
      }

      this.stateMachine.transition('watching');
      this._emitEvent(`Initial sync with ${deviceId} complete`);
    } catch (err) {
      logger.error('Initial sync failed:', err);
      this.stateMachine.transition('error');
    }
  }

  // ─── Private: Handle remote file tree ───────────────────

  private async _handleRemoteFileTree(deviceId: string, meta: FileMetaSyncPayload): Promise<void> {
    const localTree = await buildFileTree(this.vault, this.filter);
    const remoteFiles = new Map<string, typeof meta.files[number]>();
    for (const f of meta.files) {
      remoteFiles.set(f.path, f);
    }

    const treeDiff = diffFileTrees(localTree.files, remoteFiles);

    // Files only on remote — request them
    for (const file of treeDiff.remoteOnly) {
      if (file.isTextFile) {
        // For text files, initiate CRDT sync so content merges properly
        const syncData = await this.docManager.encodeSyncStep1(file.path);
        const msg = encodeYjsSync(MessageType.YJS_SYNC_STEP1, file.path, syncData);
        this.connectionManager.sendTo(deviceId, msg);
      } else {
        this.binarySync.requestFile(deviceId, file.path);
      }
    }

    // Files only locally — send them
    for (const file of treeDiff.localOnly) {
      if (file.isTextFile) {
        const syncData = await this.docManager.encodeSyncStep1(file.path);
        const msg = encodeYjsSync(MessageType.YJS_SYNC_STEP1, file.path, syncData);
        this.connectionManager.sendTo(deviceId, msg);
      } else {
        await this.binarySync.broadcastFileChange(file.path);
      }
    }

    // Conflicting files — for text files use CRDT, for binary use strategy
    for (const { local, remote } of treeDiff.conflicting) {
      if (local.isTextFile) {
        // CRDT will handle merge automatically via sync protocol
        const syncData = await this.docManager.encodeSyncStep1(local.path);
        const msg = encodeYjsSync(MessageType.YJS_SYNC_STEP1, local.path, syncData);
        this.connectionManager.sendTo(deviceId, msg);
      } else {
        // Binary conflict — use configured strategy
        if (remote.mtime > local.mtime) {
          this.binarySync.requestFile(deviceId, remote.path);
        }
        // Otherwise keep local (last-write-wins default)
      }
    }
  }

  // ─── Private: Periodic full sync ────────────────────────

  private async _periodicFullSync(): Promise<void> {
    const peers = this.connectionManager.getConnectedPeerIds();
    if (peers.length === 0) return;

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
