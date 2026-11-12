import { Vault, TAbstractFile, TFile, TFolder, Workspace } from "obsidian";
import * as Y from "yjs";
import fastDiff from "fast-diff";
import { AuthFailure, ConnectionManager } from "../transport/connection-manager";
import {
  encodeYjsSync,
  decodeYjsSync,
  encodeFileMetaSync,
  encodeFolderOp,
  encodeFileDelete,
  decodeJSON,
} from "../transport/protocol";
import { YjsDocManager } from "../crdt/yjs-doc-manager";
import { ConflictBackupService } from "../conflict/conflict-backup-service";
import { BinaryFileSyncService } from "../binary-sync/binary-sync-service";
import { VaultWatcher } from "../watcher/vault-watcher";
import { DiscoveryService } from "../discovery/discovery-service";
import { FileFilter } from "../watcher/file-filter";
import { SyncStateMachine } from "./sync-state";
import { buildFileTree, diffFileTrees, FileHashCache, FileTreeSnapshot } from "./file-tree";
import { TombstoneStore } from "./tombstones";
import { computeFileHash } from "../binary-sync/file-hash";
import { SyncLogService } from "../sync-log/sync-log-service";
import {
  FileMeta,
  FileDeletePayload,
  Tombstone,
  DeviceInfo,
  FileChangeEvent,
  FileMetaSyncPayload,
  FolderChangeEvent,
  LANSyncSettings,
  MessageType,
  SyncState,
} from "../types";
import { logger } from "../logger";
import { FILE_INDEX_FILE } from "../constants";
import { ensureParentDirectory, isSafeSyncPath } from "../utils/path-utils";
import { supportsIncomingConnections } from "../utils/runtime";
import { parsePeerAddress } from "../discovery/manual-peers";

/** Hash recorded in deletion records of folders. */
const FOLDER_HASH = "folder";

export class SyncCoordinator {
  private static readonly REMOTE_TEXT_RENAME_ALIAS_TTL_MS = 10_000;
  private connectionManager: ConnectionManager;
  private docManager: YjsDocManager;
  private binarySync: BinaryFileSyncService;
  private backupService: ConflictBackupService;
  private watcher: VaultWatcher;
  private discovery: DiscoveryService;
  private stateMachine: SyncStateMachine;
  private filter: FileFilter;
  private fullSyncTimer: ReturnType<typeof setInterval> | null = null;
  private hashCache: FileHashCache = new Map();
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private pendingInitialBootstrapPeers = new Set<string>();
  /** Tracks file paths where we are the conflict "loser" and must NOT seed
   *  the CRDT doc from disk.  Stored per winning peer so an unrelated
   *  disconnect does not clear protection for active conflicts on other peers.
   *  The winner will send us their content via YJS_UPDATE on an empty doc —
   *  initialising it from disk would cause duplication when the update is
   *  applied. */
  private renameFollowQueue: Promise<unknown> = Promise.resolve();
  private renamesInProgress = new Map<string, Promise<unknown>>();
  private remoteWriteQueues = new Map<string, Promise<void>>();
  private conflictLoserPaths = new Map<string, Set<string>>();
  private localFileChangeQueue: Promise<void> = Promise.resolve();
  private recentRemoteTextRenames = new Map<
    string,
    { newPath: string; expiresAt: number }
  >();
  /**
   * Texts we recently wrote to disk for remote changes, to recognise their
   * echoes. Obsidian can report a write after the next one has been made.
   */
  private remoteWrittenText = new Map<string, Array<{ text: string; at: number }>>();
  private workspace: Workspace | null;
  /** Files deleted here, so offline peers don't send them back. */
  private tombstones: TombstoneStore;
  /** Last seen content hash per path, recorded in a deletion record. */
  private knownHashes = new Map<string, string>();
  /** Files and hashes saved when sync last ran; see _deletedWhileStopped. */
  private lastRunFiles = new Map<string, string>();
  /** Folders a peer deleted, removed here once they hold no files (path → expiry). */
  private pendingFolderDeletes = new Map<string, number>();
  private vaultId: string;
  private syncLogService: SyncLogService | null;

  private onStateChangeCb: ((state: SyncState) => void) | null = null;
  private startError: string | null = null;
  private running = false;
  private onSyncEventCb: ((msg: string) => void) | null = null;
  private onAuthFailedCb: ((failure: AuthFailure) => void) | null = null;

  constructor(
    private vault: Vault,
    private settings: LANSyncSettings,
    options?: {
      backupService?: ConflictBackupService;
      syncLogService?: SyncLogService;
      workspace?: Workspace;
    },
  ) {
    // Generate a vault ID from the vault name
    this.vaultId = this._hashVaultId(vault.getName());

    this.filter = new FileFilter(settings.ignoredPaths);
    this.stateMachine = new SyncStateMachine();
    this.connectionManager = new ConnectionManager(settings, this.vaultId);
    this.docManager = new YjsDocManager(vault);
    this.tombstones = new TombstoneStore((vault as any).adapter);
    this.backupService =
      options?.backupService ?? new ConflictBackupService(vault);
    this.syncLogService = options?.syncLogService ?? null;
    this.binarySync = new BinaryFileSyncService(
      vault,
      this.connectionManager,
      this.backupService,
      (path) => this._isAllowedPath(path),
      (path) => this.filter.isTextFile(path),
    );
    this.workspace = options?.workspace ?? null;
    this.watcher = new VaultWatcher(
      vault,
      settings.ignoredPaths,
      options?.workspace,
    );

    const localDevice: DeviceInfo = {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      ip: "",
      port: settings.port,
      vaultId: this.vaultId,
      lastSeen: Date.now(),
      acceptsIncomingConnections: supportsIncomingConnections(),
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

  /** Called when a device is refused because its sync key differs. */
  onAuthFailed(cb: (failure: AuthFailure) => void): void {
    this.onAuthFailedCb = cb;
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

  /** Why the last start failed, in words for the user; null if it did not. */
  getStartError(): string | null {
    return this.startError;
  }

  async start(): Promise<void> {
    if (!this.settings.enabled) return;
    this.startError = null;

    try {
      this.stateMachine.transition("discovering");
      await this.tombstones.load();
      await this._loadFileIndex();

      // Start WebSocket server
      await this.connectionManager.start();

      // Start device discovery
      await this.discovery.start();

      // Connect to manual peers. One bad saved address must not stop sync.
      for (const addr of this.settings.manualPeers) {
        try {
          this.discovery.addManualPeer(addr, this.vaultId);
        } catch (err) {
          logger.warn(`Skipping invalid manual peer ${addr}:`, err);
          this._emitEvent(`Skipped invalid peer address: ${addr}`);
        }
      }

      // Start watching vault
      this.watcher.start();
      // Learn every file's hash in the background, so a deletion made
      // before the first connection still records what was deleted.
      void this._primeKnownHashes();

      // Start periodic full sync
      this.running = true;
      this.setSyncInterval(this.settings.syncIntervalMs);

      // Periodically persist CRDT state
      this.persistTimer = setInterval(() => {
        void this.docManager.persistAll();
        void this._saveFileIndex();
      }, 60000); // every 60 seconds

      this.stateMachine.transition("watching");
      this._emitEvent("Sync service started");
    } catch (err) {
      logger.error("Failed to start sync:", err);
      this.startError =
        (err as { code?: string })?.code === "EADDRINUSE"
          ? `Port ${this.settings.port} is already in use by another program or vault. Choose another port in the LAN Vault Sync settings.`
          : `Sync could not start: ${err instanceof Error ? err.message : String(err)}`;
      this._emitEvent(this.startError);
      this.stateMachine.transition("error");
    }
  }

  async stop(): Promise<void> {
    this.running = false;
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
    await this.syncLogService?.flush();
    await this.tombstones.flush();
    await this._saveFileIndex();

    this.stateMachine.transition("idle");
    this._emitEvent("Sync service stopped");
  }

  /** Change how often the file lists are compared, without a restart. */
  setSyncInterval(ms: number): void {
    if (this.fullSyncTimer) {
      clearInterval(this.fullSyncTimer);
      this.fullSyncTimer = null;
    }
    if (this.running && ms > 0) {
      this.fullSyncTimer = setInterval(() => this._periodicFullSync(), ms);
    }
  }

  /** Retry waiting connections now (app back in the foreground, network back). */
  reconnectNow(): void {
    this.connectionManager.reconnectNow();
  }

  addManualPeer(address: string): void {
    this.discovery.addManualPeer(address, this.vaultId);
  }

  /** Forget a manual peer and drop its connection right away. */
  removeManualPeer(address: string): void {
    const parsed = parsePeerAddress(address);
    if (!parsed) return;
    this.discovery.removeManualPeer(address);
    this.connectionManager.disconnectAddress(parsed.ip, parsed.port);
  }

  /** Apply edited ignored paths without restarting sync. */
  updateIgnoredPaths(paths: string[]): void {
    this.filter.updateIgnoredPaths(paths);
    this.watcher.updateIgnoredPaths(paths);
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
    this.connectionManager.onAuthFailed((failure) => {
      this._emitEvent(
        failure.reason === "outdated"
          ? `Refused ${failure.deviceName} (${failure.address}): its plugin version is older, update it there`
          : failure.reason === "newer"
            ? `Refused ${failure.deviceName} (${failure.address}): its plugin version is newer, update it here`
            : `Refused ${failure.deviceName} (${failure.address}): sync key does not match`,
      );
      this.onAuthFailedCb?.(failure);
    });

    this.connectionManager.onPeerConnected(async (device) => {
      this._emitEvent(`Connected to ${device.deviceId}`);
      // The peer count shown to the user changes even when the state does not.
      this.onStateChangeCb?.(this.stateMachine.getState());
      this.pendingInitialBootstrapPeers.add(device.deviceId);
      await this._initialSyncWith(device.deviceId);
    });

    this.connectionManager.onPeerDisconnected((deviceId) => {
      this.pendingInitialBootstrapPeers.delete(deviceId);
      this.binarySync.dropIncoming(deviceId);
      // Clear only guards associated with the disconnected peer — unrelated
      // peers may still be mid-conflict on their own paths.
      this._clearConflictLoserGuardsForDevice(deviceId);
      this._emitEvent(`Disconnected: ${deviceId}`);
      this.onStateChangeCb?.(this.stateMachine.getState());
    });

    // Incoming protocol messages
    this.connectionManager.onMessage(async (deviceId, type, payload) => {
      await this._handleMessage(deviceId, type, payload);
    });

    // Vault watcher → local changes
    this.watcher.onFileChanged((event) => {
      void this._enqueueLocalFileChange(event);
    });
    this.watcher.onFolderChanged((event) => this._handleLocalFolderChange(event));

    // Yjs doc manager → broadcast local updates
    this.docManager.onLocalUpdate((filePath, update) => {
      const msg = encodeYjsSync(MessageType.YJS_UPDATE, filePath, update);
      this.connectionManager.broadcast(msg);
    });

    // Pass peers' edits on to the other connected peers, so devices that are
    // only connected through this one (e.g. two phones and a desktop) get
    // them right away instead of at the next full sync.
    this.docManager.onRemoteUpdateApplied((filePath, update, fromDeviceId) => {
      const peers = this.connectionManager
        .getConnectedPeerIds()
        .filter((id) => id !== fromDeviceId);
      if (peers.length === 0) return;
      const msg = encodeYjsSync(MessageType.YJS_UPDATE, filePath, update);
      for (const peerId of peers) this.connectionManager.sendTo(peerId, msg);
    });

    // Yjs doc manager → remote content changed, write to file
    this.docManager.onRemoteContent(
      async (filePath, content, previousContent) => {
        await this._writeFileFromRemote(filePath, content, previousContent);
      },
    );

    // Binary sync → mark remote writes
    this.binarySync.onRemoteFileWritten((path, kind) => {
      this.watcher.markRemoteWrite(path, kind);
      if (kind !== "delete") this.tombstones.clear(path);
    });

    this.binarySync.setDeletedCheck(
      (path, hash) => this.tombstones.get(path)?.hash === hash,
    );
    // A note's text may hold edits that are not on disk yet, e.g. merged
    // in from a renamed copy; such a note is not the copy a peer deletes.
    this.binarySync.setHoldsOtherContent(async (path, hash) => {
      if (!this.filter.isTextFile(path) || !(await this.docManager.hasDocState(path))) return false;
      return (await this._hashText(await this.docManager.getContent(path))) !== hash;
    });
    this.binarySync.onRemoteFileStored((path, hash) => {
      this.knownHashes.set(path, hash);
    });

    this.binarySync.onRemoteFileDeleted(async (path, movedTo, record) => {
      // Remember the deletion too, for peers that are offline right now.
      // A peer's record of a deletion made while we were away is kept as it
      // is: when the file was deleted, and where it went if it was moved. A
      // record made now would count as a deletion later than renames made
      // meanwhile, and is taken as one by tree syncs running alongside.
      if (record) {
        const hash = record.hash ?? this.knownHashes.get(path);
        this.tombstones.clear(path);
        this.tombstones.add(path, hash, record.deletedAt, record.movedTo);
      } else {
        this.tombstones.add(path, this.knownHashes.get(path), undefined, movedTo);
      }
      this.knownHashes.delete(path);
      void this._prunePendingFolders();
      if (!this.filter.isTextFile(path)) return;
      await this.docManager.removeDoc(path);
      this._clearConflictLoserGuard(path);
    });

    // Binary sync → backup created → sync log entry
    this.binarySync.onBackupCreated((path, backupId, reason) => {
      if (!this.syncLogService) return;
      if (reason.includes("delete")) {
        this.syncLogService.addEntry("remote-delete", path, {
          snapshotId: backupId,
          hasSnapshot: true,
          details: { isText: false },
        });
      } else {
        this.syncLogService.addEntry("remote-overwrite", path, {
          snapshotId: backupId,
          hasSnapshot: true,
          details: { isText: false },
        });
      }
    });

    this.binarySync.onRemoteFileRenamed(async (oldPath, newPath) => {
      await this._recordRename(oldPath, newPath);
      void this._prunePendingFolders();
      const oldIsText = this.filter.isTextFile(oldPath);
      const newIsText = this.filter.isTextFile(newPath);

      if (oldIsText && newIsText) {
        this._rememberRemoteTextRename(oldPath, newPath);
        await this.docManager.renameDoc(oldPath, newPath);
        this._moveConflictLoserGuard(oldPath, newPath);
        return;
      }

      if (oldIsText) {
        await this.docManager.removeDoc(oldPath);
        this._clearConflictLoserGuard(oldPath);
      }
    });
  }

  // ─── Private: Message handling ──────────────────────────

  private async _handleMessage(
    deviceId: string,
    type: MessageType,
    payload: Uint8Array,
  ): Promise<void> {
    switch (type) {
      case MessageType.YJS_SYNC_STEP1: {
        const msg = decodeYjsSync(payload);
        if (!this._isAllowedPath(msg.filePath)) break;
        await this._renameSettled(msg.filePath);
        const resolvedPath = this._resolveRecentRemoteTextRename(msg.filePath);
        // Renamed here: the peer learns the new name from our file list. The
        // request carries a state vector, not changes to merge.
        if (this._renamedTextTarget(resolvedPath)) break;
        await this._flushPendingLocalTextChange(resolvedPath);
        // Ensure the local doc is seeded from disk so we don't respond with an
        // empty state when we have content the remote peer hasn't seen yet.
        // Skip seeding if we are the conflict "loser" for this path — the
        // winner will overwrite our content via YJS_UPDATE and seeding from
        // disk would cause duplication when the two states merge.
        if (!this._hasConflictLoserGuard(resolvedPath)) {
          await this._ensureCrdtInitialized(resolvedPath);
        }

        // Never answer with a diff against an unrelated history: merging two
        // independently seeded docs duplicates the whole text.
        const relation = await this.docManager.compareHistory(resolvedPath, msg.data);
        if (relation === "local-wins") {
          await this._sendFullTextState(deviceId, resolvedPath, "Resolving unrelated history");
          break;
        }
        if (relation === "remote-wins") {
          // Let the peer see our state vector; it will send its full state.
          const ourSV = await this.docManager.encodeSyncStep1(resolvedPath);
          this.connectionManager.sendTo(
            deviceId,
            encodeYjsSync(MessageType.YJS_SYNC_STEP1, resolvedPath, ourSV),
          );
          break;
        }

        const response = await this.docManager.handleSyncStep1(
          resolvedPath,
          msg.data,
        );
        const reply = encodeYjsSync(
          MessageType.YJS_SYNC_STEP2,
          resolvedPath,
          response,
        );
        this.connectionManager.sendTo(deviceId, reply);

        // Complete bidirectional sync: when the peer has changes we lack, send
        // our own state vector so it can send them. Asking only when something
        // is missing ends the exchange; a flag cleared on every STEP2 made the
        // two peers trade STEP1/STEP2 forever.
        if (await this.docManager.isMissingRemoteChanges(resolvedPath, msg.data)) {
          const ourSV = await this.docManager.encodeSyncStep1(resolvedPath);
          const reverseStep1 = encodeYjsSync(
            MessageType.YJS_SYNC_STEP1,
            resolvedPath,
            ourSV,
          );
          this.connectionManager.sendTo(deviceId, reverseStep1);
        }
        break;
      }

      case MessageType.YJS_SYNC_STEP2: {
        const msg = decodeYjsSync(payload);
        if (!this._isAllowedPath(msg.filePath)) break;
        await this._renameSettled(msg.filePath);
        const resolvedPath = this._resolveRecentRemoteTextRename(msg.filePath);
        await this._receiveRemoteUpdate(deviceId, resolvedPath, msg.data);
        break;
      }

      case MessageType.YJS_FULL_STATE: {
        const msg = decodeYjsSync(payload);
        if (!this._isAllowedPath(msg.filePath)) break;
        await this._renameSettled(msg.filePath);
        const resolvedPath = this._resolveRecentRemoteTextRename(msg.filePath);
        await this._flushPendingLocalTextChange(resolvedPath);
        if (!this._hasConflictLoserGuard(resolvedPath)) {
          await this._ensureCrdtInitialized(resolvedPath);
        }
        await this._applyFullState(deviceId, resolvedPath, msg.data);
        break;
      }

      case MessageType.YJS_UPDATE: {
        const msg = decodeYjsSync(payload);
        if (!this._isAllowedPath(msg.filePath)) break;
        await this._renameSettled(msg.filePath);
        const resolvedPath = this._resolveRecentRemoteTextRename(msg.filePath);
        await this._receiveRemoteUpdate(deviceId, resolvedPath, msg.data);
        break;
      }

      case MessageType.FILE_META_SYNC: {
        const meta = decodeJSON<FileMetaSyncPayload>(payload);
        await this._handleRemoteFileTree(deviceId, meta);

        // If this is NOT a response, send our file tree back so the peer also
        // processes our files.  This ensures bidirectional tree exchange even
        // during one-sided periodic syncs.
        if (!meta.isResponse) {
          const tree = await this._buildTree();
          const metaList = Array.from(tree.files.values());
          const reply = this._encodeTree(metaList, true);
          this.connectionManager.sendTo(deviceId, reply);
        }
        break;
      }

      case MessageType.FOLDER_CREATE: {
        const { path } = decodeJSON<{ path: string }>(payload);
        if (!this._isAllowedPath(path)) break;
        this.tombstones.clear(path);
        this.pendingFolderDeletes.delete(path);
        await this._createFolderFromRemote(path);
        break;
      }

      case MessageType.FOLDER_DELETE: {
        const { path } = decodeJSON<{ path: string }>(payload);
        if (!this._isAllowedPath(path)) break;
        this.tombstones.add(path, FOLDER_HASH);
        this._scheduleFolderDelete(path);
        break;
      }

      case MessageType.FILE_DELETE: {
        // A peer moved its copy on. If ours has not arrived yet, remember
        // where it went, so that the copy is moved there too when it does.
        // A record we already have stays as it is: when it is our own
        // rename, the peer only followed it, and a new time and hash would
        // make it look like a later rename of another file.
        const del = decodeJSON<FileDeletePayload>(payload);
        if (
          del.hash && del.movedTo && this._isAllowedPath(del.path) &&
          !this.vault.getAbstractFileByPath(del.path) && !this.tombstones.get(del.path)
        ) {
          this.tombstones.add(del.path, del.hash, undefined, del.movedTo);
        }
        await this.binarySync.handleMessage(deviceId, type, payload);
        break;
      }

      case MessageType.FILE_REQUEST:
      case MessageType.FILE_DATA:
      case MessageType.FILE_RENAME:
      case MessageType.FILE_CHUNK:
        await this.binarySync.handleMessage(deviceId, type, payload);
        break;
    }
  }

  // ─── Private: Local file changes ────────────────────────

  private _enqueueLocalFileChange(event: FileChangeEvent): Promise<void> {
    const run = async () => {
      await this._handleLocalFileChange(event);
    };

    const queued = this.localFileChangeQueue.then(run, run);
    this.localFileChangeQueue = queued.then(
      () => undefined,
      (err) => {
        logger.error(`Failed to handle local file event: ${event.type} ${event.path}`, err);
      },
    );
    return queued;
  }

  private async _handleLocalFileChange(event: FileChangeEvent): Promise<void> {
    const { type, path, oldPath, isTextFile } = event;

    switch (type) {
      case "create":
      case "modify": {
        if (isTextFile) {
          const content =
            typeof event.content === "string"
              ? event.content
              : await this._readTextFile(path);
          if (content === null || this._isEchoOfRemoteWrite(path, content)) {
            break;
          }
          this.tombstones.clear(path);
          this.knownHashes.set(path, await this._hashText(content));
          await this.docManager.applyLocalChange(path, content);
          // An empty note produces no CRDT update, so send the file itself.
          if (type === "create" && content === "") {
            await this.binarySync.broadcastFileChange(path);
          }
        } else {
          this.tombstones.clear(path);
          await this.binarySync.broadcastFileChange(path);
        }
        this.syncLogService?.addEntry("local-send", path, {
          hasSnapshot: false,
          details: { isText: isTextFile },
        });
        break;
      }

      case "delete": {
        this.tombstones.add(path, this.knownHashes.get(path));
        this.knownHashes.delete(path);
        if (isTextFile) {
          await this.docManager.removeDoc(path);
          this._clearConflictLoserGuard(path);
        }
        this.binarySync.broadcastFileDelete(path);
        this.syncLogService?.addEntry("local-send", path, {
          hasSnapshot: false,
          details: { isText: isTextFile, reason: "delete" },
        });
        break;
      }

      case "rename": {
        if (oldPath) {
          await this._recordRename(oldPath, path);
          const oldIsText = this.filter.isTextFile(oldPath);
          if (oldIsText && isTextFile) {
            await this.docManager.renameDoc(oldPath, path);
            this._moveConflictLoserGuard(oldPath, path);
          } else if (oldIsText) {
            await this.docManager.removeDoc(oldPath);
            this._clearConflictLoserGuard(oldPath);
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

  /**
   * Write a note's text from its doc. One write per note at a time: two
   * writes of a new note both created it, and the second, with the later
   * text, failed because the file existed by then, leaving the file behind
   * the doc.
   */
  private _writeFileFromRemote(
    filePath: string,
    content: string,
    previousContent: string | undefined,
  ): Promise<void> {
    const run = (this.remoteWriteQueues.get(filePath) ?? Promise.resolve()).then(() =>
      this._writeFileFromRemoteNow(filePath, content, previousContent),
    );
    this.remoteWriteQueues.set(filePath, run);
    void run.then(() => {
      if (this.remoteWriteQueues.get(filePath) === run) this.remoteWriteQueues.delete(filePath);
    });
    return run;
  }

  private async _writeFileFromRemoteNow(
    filePath: string,
    content: string,
    previousContent: string | undefined,
  ): Promise<void> {
    try {
      if (!this._isAllowedPath(filePath)) {
        logger.warn(`Rejected unsafe remote path: ${filePath}`);
        return;
      }
      await this._flushPendingLocalTextChange(filePath);
      const latestContent = await this.docManager
        .getContent(filePath)
        .catch(() => content);
      const file = this.vault.getAbstractFileByPath(filePath);
      const isExistingFile = file instanceof TFile;

      // A peer that has not yet seen our deletion may still send the note
      // as it was when we deleted it; that must not bring it back.
      const tombstone = this.tombstones.get(filePath);
      if (
        !isExistingFile &&
        tombstone?.hash &&
        tombstone.hash === (await this._hashText(latestContent))
      ) {
        logger.debug(`Not restoring deleted note: ${filePath}`);
        return;
      }

      // The note was renamed here, and a peer still sends edits under the
      // old name: merge them into the renamed note instead of bringing the
      // old name back.
      if (!isExistingFile && tombstone?.movedTo && (await this._mergeIntoRenamed(filePath))) {
        return;
      }

      // A file open in an editor is updated in the editor, which Obsidian
      // then saves. Writing the file underneath a dirty editor made Obsidian
      // merge the disk change into the editor a second time, duplicating the
      // text that was just typed there (and sending the copy back out).
      if (isExistingFile && (await this._writeToOpenEditor(filePath))) {
        this._clearConflictLoserGuard(filePath);
        return;
      }

      let backupId: string | undefined;
      let contentChanged = !isExistingFile; // new file counts as changed

      // Always back up disk content when it will be overwritten with
      // different data, regardless of whether previousContent is known.
      // This is the last safety-net against data loss.
      if (isExistingFile) {
        const diskContent = await this.vault.cachedRead(file);
        if (diskContent !== latestContent) {
          contentChanged = true;
          const needsBackup =
            typeof previousContent === "string"
              ? diskContent !== previousContent
              : true; // previousContent unknown → always back up to be safe
          if (needsBackup) {
            const backup = await this.backupService.backupTextFile(
              filePath,
              diskContent,
              "text-remote-overwrite",
              {
                previousContent: previousContent ?? "(unknown)",
                mergedContent: latestContent,
              },
            );
            if (!backup) {
              logger.error(
                `Aborting remote text overwrite for ${filePath}: conflict backup unavailable`,
              );
              this._emitEvent(
                `Skipped remote overwrite for ${filePath} because backup failed`,
              );
              return;
            }
            backupId = backup.backupId;
            logger.warn(
              `Backed up divergent text file before remote write: ${filePath} -> ${backup.contentPath}`,
            );
            this._emitEvent(`Conflict backup created for ${filePath}`);
          }
        }
      }

      if (isExistingFile && !contentChanged) {
        // Disk already has this content (e.g. bootstrapping shared CRDT state
        // for identical files). Rewriting would only bump the mtime, which
        // conflict resolution relies on.
        await this._markWritten(filePath, latestContent);
        this._clearConflictLoserGuard(filePath);
        return;
      }

      // Renamed meanwhile (Obsidian moves the file object): don't write this
      // path's text into the file under its new name.
      if (file instanceof TFile && file.path !== filePath) return;
      this.watcher.markRemoteWrite(filePath);
      this._rememberRemoteWrite(filePath, latestContent);

      if (file instanceof TFile) {
        await this.vault.modify(file, latestContent);
      } else {
        const adapter = (this.vault as any).adapter;
        if (adapter) {
          await ensureParentDirectory(adapter, filePath);
        }
        await this.vault.create(filePath, latestContent);
        this.watcher.markRemoteWrite(filePath);
        // The note is back: a record that it was deleted here no longer holds.
        this.tombstones.clear(filePath);
      }
      await this._markWritten(filePath, latestContent);

      // Sync log entry
      if (this.syncLogService && contentChanged) {
        this.syncLogService.addEntry(
          isExistingFile ? "remote-overwrite" : "initial-sync-receive",
          filePath,
          {
            snapshotId: backupId,
            hasSnapshot: !!backupId,
            details: { isText: true },
          },
        );
      }

      // If this file was in the conflict-loser set, the winner's content has
      // now been written.  Clear the guard so future syncs treat the doc
      // normally (it now has shared CRDT history with the winner).
      this._clearConflictLoserGuard(filePath);
    } catch (err) {
      logger.error(`Failed to write remote content to ${filePath}:`, err);
    }
  }

  /** Editors (Obsidian Editor objects) currently showing this file. */
  private _openEditors(filePath: string): any[] {
    const leaves = this.workspace?.getLeavesOfType?.("markdown") ?? [];
    const editors: any[] = [];
    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view?.file?.path === filePath && view.editor) editors.push(view.editor);
    }
    return editors;
  }

  /**
   * Bring an open editor up to date with the doc. Returns false when the file
   * is not open in an editor.
   */
  private async _writeToOpenEditor(filePath: string): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const editor = this._openEditors(filePath)[0];
      if (!editor) return false;

      // Fold in anything typed since the last sync first. The edit is
      // applied relative to what the editor last showed, so peer changes it
      // has not shown yet are kept.
      const current: string = editor.getValue();
      const shown = this.docManager.getWrittenContent(filePath);
      if (shown !== undefined && current !== shown) {
        this.watcher.takePendingModify(filePath);
        await this.docManager.applyLocalChange(filePath, current);
      } else if (shown === undefined) {
        this.docManager.markWritten(filePath, current);
      }
      const latest = await this.docManager.getContent(filePath);

      // Typing during the awaits above is folded in on the next round.
      if (editor.getValue() !== current) continue;
      if (current !== latest) {
        this.watcher.markRemoteWrite(filePath);
        this._rememberRemoteWrite(filePath, latest);
        let offset = 0;
        const changes: Array<{ from: any; to?: any; text: string }> = [];
        for (const [op, text] of fastDiff(current, latest)) {
          if (op === fastDiff.EQUAL) {
            offset += text.length;
          } else if (op === fastDiff.DELETE) {
            changes.push({
              from: editor.offsetToPos(offset),
              to: editor.offsetToPos(offset + text.length),
              text: "",
            });
            offset += text.length;
          } else {
            changes.push({ from: editor.offsetToPos(offset), text });
          }
        }
        editor.transaction({ changes });
      }
      await this._markWritten(filePath, latest);
      return true;
    }
    logger.warn(`Editor for ${filePath} kept changing; writing to disk instead`);
    return false;
  }

  // ─── Private: Initial sync ──────────────────────────────

  private async _initialSyncWith(deviceId: string): Promise<void> {
    this.stateMachine.transition("initial-sync");
    this._emitEvent(`Starting initial sync with ${deviceId}`);

    try {
      // Only exchange file tree metadata — NO CRDT initialization here.
      // CRDT docs are created lazily on first edit after initial sync.
      // This avoids the dual-initialization bug where both sides insert
      // the full file content into independent Y.Docs, causing duplicated
      // text when the docs are synced.
      const tree = await this._buildTree();
      const metaList = Array.from(tree.files.values());
      const msg = this._encodeTree(metaList);
      this.connectionManager.sendTo(deviceId, msg);

      this.stateMachine.transition("watching");
      this._emitEvent(`File tree sent to ${deviceId}, waiting for remote tree`);
    } catch (err) {
      logger.error("Initial sync failed:", err);
      this.stateMachine.transition("error");
    }
  }

  // ─── Private: Handle remote file tree ───────────────────

  private async _handleRemoteFileTree(
    deviceId: string,
    meta: FileMetaSyncPayload,
  ): Promise<void> {
    const localTree = await this._buildTree();
    const isInitialBootstrap = this.pendingInitialBootstrapPeers.has(deviceId);
    const remoteFiles = new Map<string, (typeof meta.files)[number]>();
    for (const f of meta.files) {
      // Never pull files this device ignores (or cannot safely write).
      if (!this._isAllowedPath(f.path)) continue;
      remoteFiles.set(f.path, f);
    }

    const treeDiff = diffFileTrees(localTree.files, remoteFiles);
    const remoteDeleted = new Map((meta.deleted ?? []).map((t) => [t.path, t]));
    // The peer gave a file the same name we did, later: keep the later
    // time, which is what other renames of the file are weighed against.
    for (const theirs of remoteDeleted.values()) {
      const ours = theirs.movedTo ? this.tombstones.get(theirs.path) : undefined;
      if (ours && ours.movedTo === theirs.movedTo && ours.hash && ours.hash === theirs.hash && theirs.deletedAt > ours.deletedAt) {
        this.tombstones.add(ours.path, ours.hash, theirs.deletedAt, ours.movedTo);
      }
    }

    // Files only on remote — request them via CRDT sync or binary transfer
    for (const file of treeDiff.remoteOnly) {
      // Deleted here while the peer was away: the peer removes its copy
      // when it sees our deletion record, so don't fetch it back.
      const ownTombstone = this.tombstones.get(file.path);
      if (ownTombstone && TombstoneStore.covers(ownTombstone, file)) {
        this._emitEvent(`Skipping deleted file: ${file.path}`);
        continue;
      }
      // Here, unchanged, when sync last ran, but the file is gone now:
      // it was deleted while sync was not running, e.g. with the app closed.
      // The peer moved a file that we deleted later, unchanged.
      const deleted = this._deletedAfterRename(file, remoteDeleted.values(), (p) => this.tombstones.get(p));
      if (deleted) {
        this.tombstones.add(file.path, file.hash, deleted.deletedAt);
        this._emitEvent(`Skipping deleted file: ${file.path}`);
        continue;
      }
      if (!ownTombstone && (await this._wasDeletedWhileStopped(file))) {
        this.connectionManager.sendTo(deviceId, encodeFileDelete({ path: file.path }));
        this._emitEvent(`Deleted while sync was off: ${file.path}`);
        continue;
      }
      if (file.isTextFile && file.size === 0) {
        // An empty note has no CRDT content to fetch; fetch the file itself.
        this.binarySync.requestFile(deviceId, file.path);
        this._emitEvent(`Requesting: ${file.path}`);
      } else if (file.isTextFile) {
        // DO NOT removeDoc here — it races with concurrent YJS_UPDATE messages
        // from the peer's localOnly processing, potentially destroying freshly
        // received content.  Sending SYNC_STEP1 with an empty state vector
        // correctly fetches all remote content regardless of local state.
        const emptyState = Y.encodeStateVector(new Y.Doc());
        const msg = encodeYjsSync(
          MessageType.YJS_SYNC_STEP1,
          file.path,
          emptyState,
        );
        this.connectionManager.sendTo(deviceId, msg);
        this._emitEvent(`Requesting text state: ${file.path}`);
      } else {
        this.binarySync.requestFile(deviceId, file.path);
        this._emitEvent(`Requesting: ${file.path}`);
      }
    }

    // Files only locally — send them to the specific peer
    for (const file of treeDiff.localOnly) {
      // The peer deleted this file while we were away.
      const peerTombstone = remoteDeleted.get(file.path);
      if (peerTombstone && TombstoneStore.covers(peerTombstone, file)) {
        await this.binarySync.applyRemoteDelete(file.path, peerTombstone);
        this._emitEvent(`Deleted (removed on ${deviceId}): ${file.path}`);
        continue;
      }
      // We moved this file, and the peer deleted it later, unchanged.
      const deletedLater = this._deletedAfterRename(file, this.tombstones.list(), (p) => remoteDeleted.get(p));
      if (deletedLater) {
        await this.binarySync.applyRemoteDelete(file.path, { ...deletedLater, path: file.path });
        this._emitEvent(`Deleted (removed on ${deviceId}): ${file.path}`);
        continue;
      }
      // The peer renamed this note while we edited it: move our edits to
      // the new name instead of keeping the old name as a second note.
      const movedTo = this._renameTarget(peerTombstone, remoteFiles, remoteDeleted);
      const later = movedTo ? null : this._laterRenameOfSameFile(file.path, remoteFiles, remoteDeleted);
      const renamedTo = movedTo ?? later?.target;
      if (renamedTo && (await this._followRemoteRename(deviceId, file.path, renamedTo, movedTo ? peerTombstone : undefined))) {
        // Take on the rename that won, so that a third device which renamed
        // the note too compares with it and not with our own, older one.
        if (later) {
          const t = later.theirs;
          this.tombstones.add(t.path, t.hash, t.deletedAt, t.movedTo);
        }
        continue;
      }
      if (file.isTextFile) {
        await this._sendFullTextState(
          deviceId,
          file.path,
          "Sending text state",
        );
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

        // Check whether we have persisted CRDT state for this file.  Persisted
        // state implies a previous sync established shared history, so a CRDT
        // merge will produce correct results.  Without shared history the two
        // Y.Docs were initialised independently and merging would concatenate
        // their full contents — a destructive duplication bug.
        const hasSharedHistory = await this.docManager.hasDocState(local.path);

        if (hasSharedHistory) {
          // Shared CRDT history exists — safe to merge via Yjs sync protocol.
          await this._ensureCrdtInitialized(local.path);
          const stateVector = await this.docManager.encodeSyncStep1(local.path);
          const msg = encodeYjsSync(
            MessageType.YJS_SYNC_STEP1,
            local.path,
            stateVector,
          );
          this.connectionManager.sendTo(deviceId, msg);
          this._emitEvent(`CRDT merge conflict: ${local.path}`);
        } else {
          // No shared history — fall back to deterministic winner selection
          // with a full backup so zero data is lost.
          const localFile = this.vault.getAbstractFileByPath(local.path);
          if (localFile instanceof TFile) {
            const content = await this.vault.cachedRead(localFile);
            const conflictBackup = await this.backupService.backupTextFile(
              local.path,
              content,
              "text-conflict-no-history",
              { localMtime: local.mtime, remoteMtime: remote.mtime },
            );
            this._emitEvent(`Conflict backup created: ${local.path}`);
            this.syncLogService?.addEntry("conflict-backup", local.path, {
              snapshotId: conflictBackup?.backupId,
              hasSnapshot: !!conflictBackup,
              details: { isText: true },
            });
          }

          const localWins = this._isConflictWinner(
            local.mtime,
            remote.mtime,
            deviceId,
          );

          if (localWins) {
            // We are the winner — send our full content.  The losing side
            // will receive it as a YJS_UPDATE on an empty doc so no
            // duplication can occur.
            await this._sendFullTextState(
              deviceId,
              local.path,
              "Sending conflict winner",
            );
          } else {
            // We are the loser — discard any queued local change and do NOT
            // initialise the CRDT doc.  The winner's YJS_UPDATE will create
            // the doc from scratch with their content, then
            // _writeFileFromRemote will create a second backup of our disk
            // content before overwriting.
            this.watcher.consumePendingModify(local.path);
            this._addConflictLoserGuard(local.path, deviceId);
            // Keep our version as a visible copy next to it, which then
            // syncs like any new note, so neither side's note disappears.
            if (localFile instanceof TFile) {
              await this._createConflictCopy(
                local.path,
                await this.vault.cachedRead(localFile),
              );
            }
            this._emitEvent(`Waiting for conflict winner: ${local.path}`);
          }
        }
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

    if (meta.folders) await this._syncFolders(meta.folders, remoteDeleted);

    if (isInitialBootstrap) {
      for (const [path, local] of localTree.files) {
        const remote = remoteFiles.get(path);
        if (!remote || !local.isTextFile) continue;
        if (local.hash !== remote.hash) continue;
        if (!this._shouldBootstrapSharedTextState(deviceId)) continue;
        // Both already hold the same history; nothing to exchange. The
        // digests come from the file lists both sides built just now.
        if (local.crdt && local.crdt === remote.crdt) continue;

        await this._sendFullTextState(
          deviceId,
          path,
          "Bootstrapping shared text state",
        );
      }

      this.pendingInitialBootstrapPeers.delete(deviceId);
    }

    this._emitEvent(
      `Tree sync with ${deviceId}: +${treeDiff.remoteOnly.length} -0 ~${treeDiff.conflicting.length}`,
    );
  }

  // ─── Private: CRDT initialization helper ─────────────────

  /**
   * Ensure the CRDT doc for filePath contains the current on-disk content.
   *
   * If the doc is already active (in pool), trust its content — it was either
   * updated by a local change event or by a recent remote update, both of
   * which are more current than disk.
   *
   * If the doc is NOT active, create one and seed it from disk silently (no
   * broadcast).  `initDocFromContentSilent` handles the case where persisted
   * state was loaded but diverges from disk by applying the diff with a
   * neutral origin that does NOT trigger the local-broadcast callback.
   */
  private async _ensureCrdtInitialized(filePath: string): Promise<void> {
    if (this.docManager.isDocSeeded(filePath)) return;
    const file = this.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    const diskContent = await this.vault.cachedRead(file);
    await this.docManager.initDocFromContentSilent(filePath, diskContent);
  }

  private async _sendFullTextState(
    deviceId: string,
    filePath: string,
    eventPrefix: string,
  ): Promise<void> {
    await this._flushPendingLocalTextChange(filePath);
    await this._ensureCrdtInitialized(filePath);
    const update = await this.docManager.encodeFullState(filePath);
    const msg = encodeYjsSync(MessageType.YJS_FULL_STATE, filePath, update);
    this.connectionManager.sendTo(deviceId, msg);
    this._emitEvent(`${eventPrefix}: ${filePath}`);
  }

  /**
   * If a local modify is still sitting in the debounce queue, ingest the
   * current on-disk content into Yjs before we process a remote update.
   */
  private async _flushPendingLocalTextChange(
    filePath: string,
  ): Promise<boolean> {
    const pending = this.watcher.takePendingModify(filePath);
    if (!pending) {
      return false;
    }

    // Prefer the editor's content: it may not have been saved to disk yet.
    const content =
      typeof pending.content === "string"
        ? pending.content
        : await this._readTextFile(filePath);
    if (content === null || this._isEchoOfRemoteWrite(filePath, content)) {
      return false;
    }

    await this.docManager.applyLocalChange(filePath, content);
    return true;
  }

  // ─── Public: Manual full sync with progress ─────────────

  async manualFullSync(
    onProgress: (percent: number, message: string) => void,
  ): Promise<void> {
    const peers = this.connectionManager.getConnectedPeerIds();
    if (peers.length === 0) {
      onProgress(100, "No connected peers");
      return;
    }

    onProgress(5, "Building file tree...");
    const tree = await this._buildTree();
    const metaList = Array.from(tree.files.values());
    onProgress(
      15,
      `Found ${metaList.length} files, syncing with ${peers.length} peer(s)...`,
    );

    const totalPeers = peers.length;
    for (let i = 0; i < peers.length; i++) {
      const peerId = peers[i];
      const peerPercent = 20 + ((i + 1) / totalPeers) * 50;

      const msg = this._encodeTree(metaList);
      this.connectionManager.sendTo(peerId, msg);
      onProgress(peerPercent, `Sent file tree to peer ${i + 1}/${totalPeers}`);

      if (i < peers.length - 1) {
        await new Promise<void>((r) => setTimeout(r, 500));
      }
    }

    // Wait for sync events to settle (no new events for 2s, max 30s)
    onProgress(75, "Waiting for sync responses...");
    let lastEventTime = Date.now();
    const origCb = this.onSyncEventCb;
    this.onSyncEventCb = (msg: string) => {
      lastEventTime = Date.now();
      origCb?.(msg);
    };

    const maxWait = 30_000;
    const idleThreshold = 2_000;
    const startWait = Date.now();

    while (
      Date.now() - lastEventTime < idleThreshold &&
      Date.now() - startWait < maxWait
    ) {
      await new Promise<void>((r) => setTimeout(r, 500));
      const elapsed = Date.now() - startWait;
      const waitPercent = Math.min(95, 78 + (elapsed / maxWait) * 17);
      onProgress(waitPercent, "Processing sync...");
    }

    this.onSyncEventCb = origCb;

    onProgress(96, "Persisting state...");
    await this.docManager.persistAll();

    onProgress(
      100,
      `Sync complete — ${metaList.length} files checked with ${totalPeers} peer(s)`,
    );
  }

  // ─── Private: Periodic full sync ────────────────────────

  private async _periodicFullSync(): Promise<void> {
    const peers = this.connectionManager.getConnectedPeerIds();
    if (peers.length === 0) return;

    // Re-send file tree metadata to trigger tree diff on peers
    const tree = await this._buildTree();
    const metaList = Array.from(tree.files.values());
    const msg = this._encodeTree(metaList);

    for (const peerId of peers) {
      this.connectionManager.sendTo(peerId, msg);
    }
  }

  // ─── Private: Helpers ───────────────────────────────────

  private async _buildTree(): Promise<FileTreeSnapshot> {
    // Unchanged files keep their hash, so the periodic sync does not read
    // the whole vault every time.
    const tree = await buildFileTree(this.vault, this.filter, this.hashCache);
    for (const [path, meta] of tree.files) {
      this.knownHashes.set(path, meta.hash);
      if (meta.isTextFile) {
        const crdt = await this.docManager.crdtDigest(path);
        tree.files.set(path, crdt ? { ...meta, crdt } : { ...meta, crdt: undefined });
      }
    }
    return tree;
  }

  // ─── Private: folders ─────────────────────────────────────

  private _listFolders(): string[] {
    const all: TAbstractFile[] = (this.vault as any).getAllLoadedFiles?.() ?? [];
    return all
      .filter((f) => f instanceof TFolder && !f.isRoot() && this._isAllowedPath(f.path))
      .map((f) => f.path);
  }

  private _handleLocalFolderChange(event: FolderChangeEvent): void {
    if (event.type === "create") {
      this.tombstones.clear(event.path);
      this.connectionManager.broadcast(encodeFolderOp(MessageType.FOLDER_CREATE, event.path));
      return;
    }
    const gone = event.type === "rename" ? event.oldPath! : event.path;
    this.tombstones.add(gone, FOLDER_HASH);
    if (event.type === "rename") {
      this.tombstones.clear(event.path);
      this.connectionManager.broadcast(encodeFolderOp(MessageType.FOLDER_CREATE, event.path));
    }
    this.connectionManager.broadcast(encodeFolderOp(MessageType.FOLDER_DELETE, gone));
  }

  /** Create folders the peer has, and remove empty ones the peer deleted. */
  private async _syncFolders(
    remoteFolders: string[],
    remoteDeleted: Map<string, { hash?: string }>,
  ): Promise<void> {
    const remote = new Set(remoteFolders.filter((p) => this._isAllowedPath(p)));
    for (const path of remote) {
      if (this.vault.getAbstractFileByPath(path)) continue;
      if (this.tombstones.get(path)?.hash === FOLDER_HASH) continue;
      await this._createFolderFromRemote(path);
    }
    for (const path of this._listFolders()) {
      if (remote.has(path)) continue;
      if (remoteDeleted.get(path)?.hash === FOLDER_HASH) this._scheduleFolderDelete(path);
    }
  }

  private async _createFolderFromRemote(path: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("/");
      if (this.vault.getAbstractFileByPath(sub)) continue;
      this.watcher.markRemoteWrite(sub, "write");
      try {
        await this.vault.createFolder(sub);
      } catch (err) {
        logger.warn(`Could not create folder ${sub}:`, err);
        return;
      }
    }
  }

  private _scheduleFolderDelete(path: string): void {
    // Files inside may still be on their way out (moved or deleted by the
    // same change), so keep trying for a while.
    this.pendingFolderDeletes.set(path, Date.now() + 60_000);
    void this._prunePendingFolders();
  }

  private async _prunePendingFolders(): Promise<void> {
    // Deepest first, so a parent is checked after its subfolders are gone.
    const paths = [...this.pendingFolderDeletes.keys()].sort((a, b) => b.length - a.length);
    for (const path of paths) {
      const expiry = this.pendingFolderDeletes.get(path);
      if (expiry === undefined) continue;
      const folder = this.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder) || expiry < Date.now()) {
        this.pendingFolderDeletes.delete(path);
        continue;
      }
      if (this._holdsFiles(folder)) continue;
      this.pendingFolderDeletes.delete(path);
      const markAll = (f: TFolder) => {
        this.watcher.markRemoteWrite(f.path, "delete");
        for (const child of f.children) if (child instanceof TFolder) markAll(child);
      };
      markAll(folder);
      try {
        await this.vault.delete(folder, true);
        this._emitEvent(`Deleted folder: ${path}`);
      } catch (err) {
        logger.warn(`Could not delete folder ${path}:`, err);
      }
    }
  }

  private _holdsFiles(folder: TFolder): boolean {
    return folder.children.some((c) =>
      c instanceof TFolder ? this._holdsFiles(c) : true,
    );
  }

  /**
   * Whether a note the peer has was synced here and then deleted while sync
   * was not running, with the peer's copy unchanged since. Records the
   * deletion if so. A peer copy edited since is fetched again instead.
   */
  /**
   * A file that was here, unchanged, when sync last ran and is gone now was
   * deleted while sync was not running, e.g. with the app closed.
   */
  private async _wasDeletedWhileStopped(file: FileMeta): Promise<boolean> {
    if (this.vault.getAbstractFileByPath(file.path)) return false;
    if (this.lastRunFiles.get(file.path) !== file.hash) return false;
    this.lastRunFiles.delete(file.path);
    this.tombstones.add(file.path, file.hash);
    if (file.isTextFile) await this.docManager.removeDoc(file.path);
    return true;
  }

  private async _loadFileIndex(): Promise<void> {
    const adapter = (this.vault as any).adapter;
    try {
      if (!adapter || !(await adapter.exists(FILE_INDEX_FILE))) return;
      const saved = JSON.parse(await adapter.read(FILE_INDEX_FILE)) as Record<string, string>;
      for (const [path, hash] of Object.entries(saved)) {
        if (typeof hash === "string") this.lastRunFiles.set(path, hash);
      }
    } catch (err) {
      logger.warn("Could not read the list of synced files:", err);
    }
  }

  private async _saveFileIndex(): Promise<void> {
    const adapter = (this.vault as any).adapter;
    if (!adapter) return;
    const index: Record<string, string> = {};
    for (const [path, hash] of this.knownHashes) index[path] = hash;
    try {
      await ensureParentDirectory(adapter, FILE_INDEX_FILE);
      await adapter.write(FILE_INDEX_FILE, JSON.stringify(index));
    } catch (err) {
      logger.warn("Could not save the list of synced files:", err);
    }
  }

  private async _primeKnownHashes(): Promise<void> {
    try {
      const tree = await buildFileTree(this.vault, this.filter, this.hashCache);
      for (const [path, meta] of tree.files) {
        // A change seen meanwhile already recorded a newer hash.
        if (!this.knownHashes.has(path)) this.knownHashes.set(path, meta.hash);
      }
    } catch (err) {
      logger.warn("Could not read file hashes at start:", err);
    }
  }

  private _encodeTree(files: FileMeta[], isResponse?: boolean): Uint8Array {
    const deleted = this.tombstones.list().filter((t) => !this.filter.shouldIgnore(t.path));
    return encodeFileMetaSync(
      isResponse
        ? { files, folders: this._listFolders(), deleted, isResponse: true }
        : { files, folders: this._listFolders(), deleted },
    );
  }

  /**
   * Record text written from a peer: the editor baseline for local edits,
   * and the hash a later deletion records so offline peers can tell an
   * unchanged copy (delete it) from one edited meanwhile (keep it).
   */
  private async _markWritten(filePath: string, content: string): Promise<void> {
    this.docManager.markWritten(filePath, content);
    this.knownHashes.set(filePath, await this._hashText(content));
  }

  private async _hashText(content: string): Promise<string> {
    const bytes = new TextEncoder().encode(content);
    return computeFileHash(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  }

  /** A rename removes the old path for peers that were offline. */
  /** Where a peer's renamed file is now, following renames made one after another. */
  private _renameTarget(
    tombstone: Tombstone | undefined,
    remoteFiles: Map<string, FileMeta>,
    remoteDeleted: Map<string, Tombstone>,
  ): string | null {
    let target = tombstone?.movedTo;
    for (let hops = 0; target && hops < 8; hops++) {
      if (remoteFiles.has(target)) return target;
      target = remoteDeleted.get(target)?.movedTo;
    }
    return null;
  }

  /** Merge a doc received under a renamed note's old name into the note. */
  /**
   * A peer that has not seen a rename yet sends changes under the old name.
   * Apply them to the renamed note when they continue its history. A doc
   * for the old name is not recreated: it would forget which changes it
   * already passed on, and peers would keep sending them to each other.
   */
  private async _applyToRenamed(deviceId: string, oldPath: string, update: Uint8Array): Promise<boolean> {
    const target = this._renamedTextTarget(oldPath);
    if (!target) return false;
    await this._flushPendingLocalTextChange(target);
    await this._ensureCrdtInitialized(target);
    return this.docManager.applyRelatedUpdate(target, update, deviceId);
  }

  /** The existing note that a missing note was renamed to, if any. */
  private _renamedTextTarget(oldPath: string): string | null {
    if (!this.filter.isTextFile(oldPath) || this.vault.getAbstractFileByPath(oldPath)) return null;
    let target = this.tombstones.get(oldPath)?.movedTo;
    for (let hops = 0; target && hops < 8; hops++) {
      if (this.vault.getAbstractFileByPath(target) instanceof TFile) {
        return this.filter.isTextFile(target) ? target : null;
      }
      target = this.tombstones.get(target)?.movedTo;
    }
    return null;
  }

  private async _mergeIntoRenamed(oldPath: string): Promise<boolean> {
    let target = this.tombstones.get(oldPath)?.movedTo;
    for (let hops = 0; target && hops < 8; hops++) {
      if (this.vault.getAbstractFileByPath(target) instanceof TFile) break;
      target = this.tombstones.get(target)?.movedTo;
    }
    if (!target || !this.filter.isTextFile(target)) return false;
    if (!(this.vault.getAbstractFileByPath(target) instanceof TFile)) return false;
    await this._flushPendingLocalTextChange(target);
    await this._ensureCrdtInitialized(target);
    const merged = await this.docManager.absorbDoc(oldPath, target);
    // Unrelated history: someone made a new note under the old name.
    if (!merged) return false;
    await this.docManager.removeDoc(oldPath);
    if (merged.content !== merged.previousContent) {
      await this._writeFileFromRemote(target, merged.content, merged.previousContent);
    }
    this._emitEvent(`Merged edits for ${oldPath} into ${target}`);
    return true;
  }

  /**
   * The deletion of a file's old name made after the file was renamed to
   * `file.path`, when the file is unchanged since: the later of the two
   * wins, as between two renames. `renames` are one side's records, and
   * `deletionOf` looks up the other side's.
   */
  private _deletedAfterRename(
    file: FileMeta,
    renames: Iterable<Tombstone>,
    deletionOf: (path: string) => Tombstone | undefined,
  ): Tombstone | null {
    for (const moved of renames) {
      if (moved.movedTo !== file.path || !moved.hash) continue;
      const deleted = deletionOf(moved.path);
      if (!deleted || deleted.movedTo || deleted.hash !== moved.hash) continue;
      if (file.hash === deleted.hash && deleted.deletedAt > moved.deletedAt) return deleted;
    }
    return null;
  }

  /**
   * When we renamed a file to `path` and the peer renamed the same file to
   * another name, the later rename wins (ties go to the smaller name), so
   * one copy is kept instead of one under each name.
   */
  private _laterRenameOfSameFile(
    path: string,
    remoteFiles: Map<string, FileMeta>,
    remoteDeleted: Map<string, Tombstone>,
  ): { target: string; theirs: Tombstone } | null {
    for (const ours of this.tombstones.list()) {
      if (ours.movedTo !== path) continue;
      const theirs = remoteDeleted.get(ours.path);
      if (!theirs?.movedTo || theirs.movedTo === path) continue;
      // The same file: both records name the content that was renamed.
      if (!ours.hash || ours.hash !== theirs.hash) continue;
      const target = this._renameTarget(theirs, remoteFiles, remoteDeleted);
      if (!target || target === path) continue;
      const theirsWins =
        theirs.deletedAt > ours.deletedAt ||
        (theirs.deletedAt === ours.deletedAt && target < path);
      return theirsWins ? { target, theirs } : null;
    }
    return null;
  }

  /**
   * Move this device's edited copy of a note that a peer renamed to the new
   * name: rename it here, or, when the new name already arrived, merge our
   * edits into it. Only done when both copies share sync history, so the
   * merge is exact. Returns false (both names are kept) otherwise.
   */
  private _followRemoteRename(
    deviceId: string,
    oldPath: string,
    newPath: string,
    record?: Tombstone,
  ): Promise<boolean> {
    // One at a time: tree syncs with several peers can lead to following the
    // same rename at once, and Obsidian moves the very file object, so a
    // second follow would see the moved file as the new name's note.
    const run = this.renameFollowQueue.then(() =>
      this._followRemoteRenameNow(deviceId, oldPath, newPath, record),
    );
    this.renameFollowQueue = run.catch(() => undefined);
    const settled = this.renameFollowQueue;
    for (const path of [oldPath, newPath]) this.renamesInProgress.set(path, settled);
    void settled.then(() => {
      for (const path of [oldPath, newPath]) {
        if (this.renamesInProgress.get(path) === settled) this.renamesInProgress.delete(path);
      }
    });
    return run;
  }

  /**
   * Wait while a note is moved to or from `path`. Text for the note that
   * arrives then would otherwise start a doc of its own under the new name,
   * apart from the one being moved there, or bring the old name back.
   */
  private async _renameSettled(path: string): Promise<void> {
    await this.renamesInProgress.get(path);
  }

  private async _followRemoteRenameNow(
    deviceId: string,
    oldPath: string,
    newPath: string,
    record?: Tombstone,
  ): Promise<boolean> {
    const isText = this.filter.isTextFile(oldPath);
    if (!this._isAllowedPath(newPath) || this.filter.isTextFile(newPath) !== isText) return false;
    const file = this.vault.getAbstractFileByPath(oldPath);
    // Already followed, e.g. for another peer a moment ago.
    if (!(file instanceof TFile)) return this.tombstones.get(oldPath)?.movedTo === newPath;
    // We deleted the new name ourselves; don't bring it back.
    if (this.tombstones.get(newPath)) return false;
    if (isText) {
      if (!(await this.docManager.hasDocState(oldPath))) return false;
      await this._flushPendingLocalTextChange(oldPath);
      await this._ensureCrdtInitialized(oldPath);
    }
    const oldHash = await computeFileHash(await this.vault.readBinary(file));

    const target = this.vault.getAbstractFileByPath(newPath);
    // The peer's text for the new name may have arrived before its file is
    // written. Our file must not take that name then: the pending write
    // would put the peer's text over it, without our edits.
    const peerDocArrived = isText && !target && (await this.docManager.hasDocState(newPath));
    if (isText && (target || peerDocArrived)) {
      if (target && (!(target instanceof TFile) || target === file)) return false;
      if (target) {
        await this._flushPendingLocalTextChange(newPath);
        await this._ensureCrdtInitialized(newPath);
      }
      const merged = await this.docManager.absorbDoc(oldPath, newPath);
      if (!merged) return false;
      if (!target) {
        const slash = newPath.lastIndexOf("/");
        if (slash > 0) await this._createFolderFromRemote(newPath.slice(0, slash));
      }
      await this._writeFileFromRemote(newPath, merged.content, merged.previousContent);
      if (file.path !== oldPath) return false;
      this.watcher.markRemoteWrite(oldPath, "delete");
      await this.vault.delete(file);
      this.tombstones.add(oldPath, oldHash, undefined, newPath);
      this._keepRenameRecord(oldPath, record);
      this.knownHashes.delete(oldPath);
      await this.docManager.removeDoc(oldPath);
    } else if (!target) {
      const slash = newPath.lastIndexOf("/");
      if (slash > 0) await this._createFolderFromRemote(newPath.slice(0, slash));
      if (file.path !== oldPath) return false;
      this.watcher.markRemoteWrite(newPath, "rename");
      await this.vault.rename(file, newPath);
      this.knownHashes.set(oldPath, oldHash);
      await this._recordRename(oldPath, newPath);
      this._keepRenameRecord(oldPath, record);
      if (isText) {
        await this.docManager.renameDoc(oldPath, newPath);
        // Fetch the peer's changes to the renamed note.
        const ourState = await this.docManager.encodeSyncStep1(newPath);
        this.connectionManager.sendTo(
          deviceId,
          encodeYjsSync(MessageType.YJS_SYNC_STEP1, newPath, ourState),
        );
      }
    } else {
      // An attachment is only dropped when the new name holds the same file.
      if (!(target instanceof TFile)) return false;
      if ((await computeFileHash(await this.vault.readBinary(target))) !== oldHash) return false;
      if (file.path !== oldPath) return false;
      this.watcher.markRemoteWrite(oldPath, "delete");
      await this.vault.delete(file);
      this.tombstones.add(oldPath, oldHash, undefined, newPath);
      this.knownHashes.delete(oldPath);
    }
    // Peers may already have fetched our copy under the old name. Only that
    // exact copy is removed; another device's edited copy is kept and moved
    // over by that device.
    this.connectionManager.broadcast(encodeFileDelete({ path: oldPath, hash: oldHash, movedTo: newPath }));
    this._emitEvent(`Moved edits to renamed note: ${oldPath} -> ${newPath}`);
    return true;
  }

  /**
   * After following a peer's rename, record it as the peer did: when it was
   * made and what was renamed. Recorded as made now, with this device's
   * edited content, it would beat any other rename of the note made
   * meanwhile, and no longer be seen as a rename of the same note.
   */
  private _keepRenameRecord(oldPath: string, record: Tombstone | undefined): void {
    if (!record?.movedTo || record.path !== oldPath) return;
    this.tombstones.clear(oldPath);
    this.tombstones.add(oldPath, record.hash, record.deletedAt, record.movedTo);
  }

  private async _recordRename(oldPath: string, newPath: string): Promise<void> {
    // The hash may not be known yet right after start; the renamed file
    // still has the content the old name had.
    let hash = this.knownHashes.get(oldPath);
    if (!hash) {
      const file = this.vault.getAbstractFileByPath(newPath);
      if (file instanceof TFile) {
        try {
          hash = await computeFileHash(await this.vault.readBinary(file));
        } catch {
          // Gone again already; the deletion is recorded without a hash.
        }
      }
    }
    this.tombstones.add(oldPath, hash, undefined, newPath);
    this.tombstones.clear(newPath);
    this.knownHashes.delete(oldPath);
    if (hash) this.knownHashes.set(newPath, hash);
  }

  private _hashVaultId(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      const char = name.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return "vault-" + Math.abs(hash).toString(36);
  }

  private _emitEvent(msg: string): void {
    logger.info(msg);
    this.onSyncEventCb?.(msg);
  }

  private async _readTextFile(path: string): Promise<string | null> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return null;
    }

    return this.vault.cachedRead(file);
  }

  /**
   * True when `content` is what we last wrote for a remote change, i.e. the
   * modify event is our own write coming back. Any other content is a real
   * local edit; from then on the remembered write no longer applies.
   */
  private _isEchoOfRemoteWrite(path: string, content: string): boolean {
    const written = this.remoteWrittenText.get(path);
    if (written === undefined) return false;
    const since = Date.now() - SyncCoordinator.REMOTE_WRITE_ECHO_MS;
    // The newest write is an echo however late; earlier ones only shortly after.
    if (written.some((w, i) => w.text === content && (i === written.length - 1 || w.at >= since))) {
      return true;
    }
    this.remoteWrittenText.delete(path);
    return false;
  }

  private static readonly REMOTE_WRITE_ECHO_MS = 30000;

  private _rememberRemoteWrite(path: string, text: string): void {
    const written = this.remoteWrittenText.get(path) ?? [];
    written.push({ text, at: Date.now() });
    if (written.length > 8) written.shift();
    this.remoteWrittenText.set(path, written);
  }

  private _rememberRemoteTextRename(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const expiresAt =
      Date.now() + SyncCoordinator.REMOTE_TEXT_RENAME_ALIAS_TTL_MS;
    this.recentRemoteTextRenames.set(oldPath, { newPath, expiresAt });
  }

  private _resolveRecentRemoteTextRename(filePath: string): string {
    let resolvedPath = filePath;
    const visited = new Set<string>();

    while (!visited.has(resolvedPath)) {
      visited.add(resolvedPath);
      const alias = this.recentRemoteTextRenames.get(resolvedPath);
      if (!alias) break;
      if (alias.expiresAt <= Date.now()) {
        this.recentRemoteTextRenames.delete(resolvedPath);
        break;
      }
      resolvedPath = alias.newPath;
    }

    return resolvedPath;
  }

  /**
   * Before applying a peer's update, make sure our doc holds what is on disk.
   * If the update starts another history of the note (it was created on two
   * devices apart), settle which history to keep instead of merging both
   * texts into one note. Returns true when the update was handled here.
   */
  private async _receiveRemoteUpdate(
    deviceId: string,
    filePath: string,
    update: Uint8Array,
  ): Promise<void> {
    if (await this._applyToRenamed(deviceId, filePath, update)) return;
    await this._flushPendingLocalTextChange(filePath);
    if (!this._hasConflictLoserGuard(filePath)) {
      await this._ensureCrdtInitialized(filePath);
    }
    if (!(await this.docManager.applyRelatedUpdate(filePath, update, deviceId))) {
      // A separate history of the note: keep one of the two, never both.
      await this._applyFullState(deviceId, filePath, update);
    }
  }

  /** Apply a peer's whole doc; see YjsDocManager.applyFullState. */
  private async _applyFullState(
    deviceId: string,
    filePath: string,
    update: Uint8Array,
  ): Promise<void> {
    const file = this.vault.getAbstractFileByPath(filePath);
    const before = file instanceof TFile ? await this.vault.read(file) : "";
    const result = await this.docManager.applyFullState(filePath, update, deviceId);
    if (result === "kept-local") {
      // Our doc wins; send it so the peer adopts it.
      await this._sendFullTextState(deviceId, filePath, "Resolving unrelated history");
    } else if (result === "adopted") {
      // The note we had came from another history and is now replaced.
      if (before !== (await this.docManager.getContent(filePath))) {
        await this._createConflictCopy(filePath, before);
      }
      // Other peers may still hold the history we just dropped.
      for (const peerId of this.connectionManager.getConnectedPeerIds()) {
        if (peerId !== deviceId) {
          await this._sendFullTextState(peerId, filePath, "Sharing adopted history");
        }
      }
    }
  }

  /**
   * Keep a version of a note that lost a conflict as "name (conflict 1a2b3c).ext".
   * The suffix comes from the content, so devices that keep the same version
   * create the same file instead of one copy each.
   */
  private async _createConflictCopy(filePath: string, content: string): Promise<void> {
    if (!content) return;
    const slash = filePath.lastIndexOf("/");
    const dot = filePath.lastIndexOf(".");
    const extAt = dot > slash ? dot : filePath.length;
    const hash = await computeFileHash(new TextEncoder().encode(content).buffer as ArrayBuffer);
    const copyPath = `${filePath.slice(0, extAt)} (conflict ${hash.slice(0, 6)})${filePath.slice(extAt)}`;
    if (this.vault.getAbstractFileByPath(copyPath)) return;
    try {
      await this.vault.create(copyPath, content);
      this._emitEvent(`Kept the other version as ${copyPath}`);
    } catch (err) {
      logger.warn(`Could not create conflict copy for ${filePath}:`, err);
    }
  }

  private _shouldBootstrapSharedTextState(deviceId: string): boolean {
    return this.settings.deviceId <= deviceId;
  }

  private _hasConflictLoserGuard(filePath: string): boolean {
    return (this.conflictLoserPaths.get(filePath)?.size ?? 0) > 0;
  }

  private _addConflictLoserGuard(filePath: string, deviceId: string): void {
    const peerIds = this.conflictLoserPaths.get(filePath) ?? new Set<string>();
    peerIds.add(deviceId);
    this.conflictLoserPaths.set(filePath, peerIds);
  }

  private _clearConflictLoserGuard(filePath: string, deviceId?: string): void {
    if (!deviceId) {
      this.conflictLoserPaths.delete(filePath);
      return;
    }

    const peerIds = this.conflictLoserPaths.get(filePath);
    if (!peerIds) return;

    peerIds.delete(deviceId);
    if (peerIds.size === 0) {
      this.conflictLoserPaths.delete(filePath);
    }
  }

  private _clearConflictLoserGuardsForDevice(deviceId: string): void {
    for (const filePath of this.conflictLoserPaths.keys()) {
      this._clearConflictLoserGuard(filePath, deviceId);
    }
  }

  private _moveConflictLoserGuard(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;

    const peerIds = this.conflictLoserPaths.get(oldPath);
    if (!peerIds) return;

    this.conflictLoserPaths.set(newPath, new Set(peerIds));
    this.conflictLoserPaths.delete(oldPath);
  }

  /**
   * Deterministic conflict winner selection.  Both sides compute the same
   * result so exactly one sends its content and the other waits.
   *
   * Winner: the side with the more-recent mtime.  On tie: the side whose
   * deviceId is lexicographically smaller.
   */
  /**
   * Whether a path from a peer may be read or written here: it must be safe
   * and not in this device's ignored paths (incoming files and requests for
   * our files are filtered the same way as local changes).
   */
  private _isAllowedPath(filePath: string): boolean {
    return isSafeSyncPath(filePath) && !this.filter.shouldIgnore(filePath);
  }

  private _isConflictWinner(
    localMtime: number,
    remoteMtime: number,
    remoteDeviceId: string,
  ): boolean {
    if (localMtime !== remoteMtime) {
      return localMtime > remoteMtime;
    }
    return this.settings.deviceId < remoteDeviceId;
  }
}
