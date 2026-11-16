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
import { ensureParentDirectory, isCaseVariant, isSafeSyncPath, unportableNameChars } from "../utils/path-utils";
import { supportsIncomingConnections } from "../utils/runtime";
import { parsePeerAddress } from "../discovery/manual-peers";
import { isPlainUtf8, utf8Length } from "../utils/utf8";

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
  /** A file list exchange asked for sooner than the next periodic one. */
  private treeSyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hashes of all files read at start; see _primeKnownHashes. */
  private primed: Promise<void> = Promise.resolve();
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
  /**
   * Copies of a note that a peer has moved on to the note's new name, by
   * old path: content hash and when the notice came. See _wasMovedOn.
   */
  private movedOnCopies = new Map<string, Map<string, number>>();
  private conflictLoserPaths = new Map<string, Set<string>>();
  /**
   * Notes whose copies here and on a peer differ, by peer and path: which
   * copy is kept if the two turn out to have separate histories, and whether
   * the other one is kept as a conflict copy. Both devices settle this from
   * the same pair of file lists, so they agree. See _decideConflict.
   */
  private historyWinners = new Map<string, { localWins: boolean; keepCopy: boolean }>();
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
  /** Hashes of text files written from a peer's bytes (see isPlainUtf8). */
  private remoteWrittenBytes = new Map<string, string>();
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
  private onUnsyncableCb: ((path: string, reason: string) => void) | null = null;
  /** Files the user was told cannot be synced, so it is told once. */
  private reportedUnsyncable = new Set<string>();
  /** Whether the vault's storage tells names that differ in case apart. */
  private caseInsensitive: Promise<boolean> | null = null;

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
    this.docManager.setKeepsWrittenContent((path) => this._openEditors(path).length > 0);
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

  /** Called once per file that cannot be synced to or from this device. */
  onUnsyncableFile(cb: (path: string, reason: string) => void): void {
    this.onUnsyncableCb = cb;
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

  getConnectedPeers(): DeviceInfo[] {
    return this.connectionManager.getConnectedPeers();
  }

  /** Addresses added by hand that keep failing to connect; still retried. */
  getUnreachablePeers(): string[] {
    return this.connectionManager.getUnreachablePeers();
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
      this.primed = this._primeKnownHashes();

      // Start periodic full sync
      this.running = true;
      this.setSyncInterval(this.settings.syncIntervalMs);

      // Notes are saved as they change (see YjsDocManager._commit); this
      // catches a save that failed, and saves the indexes.
      this.persistTimer = setInterval(() => void this.persist(), 60000);

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
    if (this.treeSyncTimer) {
      clearTimeout(this.treeSyncTimer);
      this.treeSyncTimer = null;
    }

    this.watcher.stop();
    // Changes already seen are recorded before the records are saved: a
    // deletion or rename handled after that was lost to the next start.
    await this.localFileChangeQueue;
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

  /**
   * Write everything that is only in memory. Called when the app is about
   * to close or go to the background, where it may be stopped without
   * notice.
   */
  async persist(): Promise<void> {
    if (!this.running) return;
    await this.docManager.persistAll();
    await this.tombstones.flush();
    await this._saveFileIndex();
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
      this.connectionManager.forgetDiscoveredPeer(device);
    });
    this.connectionManager.onReachabilityChange(() => this.onStateChangeCb?.(this.stateMachine.getState()));

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
      this._forgetHistoryWinners(deviceId);
      this._forgetSent(deviceId);
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
    this.binarySync.onRemoteFileWritten((path, kind, content) => {
      this.watcher.markRemoteWrite(path, kind);
      if (kind !== "delete") this.tombstones.clear(path);
      // A note's text written as bytes: its modify event is this write.
      if (content && this.filter.isTextFile(path) && isPlainUtf8(content)) {
        this._rememberRemoteWrite(path, new TextDecoder().decode(content));
      }
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
    this.binarySync.setCanCreate(async (path) => !(await this._refuseCaseClash(path)));
    this.binarySync.onRemoteFileStored(async (path, hash, content, fromDeviceId) => {
      this.knownHashes.set(path, hash);
      if (this.filter.isTextFile(path)) await this._storedTextAsBytes(path, hash, content, fromDeviceId);
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
      this.remoteWrittenText.delete(path);
      // Deleted while sync runs: once the deletion is undone (see
      // TombstoneStore.revive), the file being gone here must not be taken
      // for a deletion made while sync was off, which deleted it again.
      this.lastRunFiles.delete(path);
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
      // Neither name is here, and we renamed or deleted the file ourselves:
      // both devices changed it at once. Our record must stay as it is, so
      // that comparing both records settles it (the later change wins); a
      // file list exchange does that now, not at the next periodic sync.
      const ours = this.tombstones.get(oldPath);
      if (
        ours && ours.movedTo !== newPath && ours.hash !== FOLDER_HASH &&
        !this.vault.getAbstractFileByPath(oldPath) && !this.vault.getAbstractFileByPath(newPath)
      ) {
        this._scheduleTreeSync();
        return;
      }
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
        const relation = await this.docManager.compareHistory(
          resolvedPath,
          msg.data,
          this.historyWinners.get(this._peerPathKey(deviceId, resolvedPath))?.localWins,
        );
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
          !this.vault.getAbstractFileByPath(del.path)
        ) {
          if (!this.tombstones.get(del.path)) {
            this.tombstones.add(del.path, del.hash, undefined, del.movedTo);
          } else {
            this._rememberMovedOn(del.path, del.hash);
          }
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
          const fromEditor = typeof event.content === "string";
          const content = fromEditor
            ? (event.content as string)
            : await this._readTextFile(path);
          if (content === null) {
            if (await this._holdsNonUtf8(path)) await this._sendTextAsBytes(path);
            break;
          }
          if (this._isEchoOfRemoteWrite(path, content)) {
            await this._noteDiskText(path, fromEditor, event.savedToDisk, content);
            break;
          }
          this._reviveIfDeleted(path);
          this.knownHashes.set(path, await this._hashText(content));
          await this.docManager.applyLocalChange(path, content, !fromEditor);
          await this._noteDiskText(path, fromEditor, event.savedToDisk);
          // An empty note produces no CRDT update, so send the file itself.
          if (type === "create" && content === "") {
            await this.binarySync.broadcastFileChange(path);
          }
        } else {
          this._reviveIfDeleted(path);
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
        const deletedAt = this.tombstones.get(path)?.deletedAt;
        this.knownHashes.delete(path);
        // A file made again with the text we last wrote is a new file, not
        // our own write coming back.
        this.remoteWrittenText.delete(path);
        this.lastRunFiles.delete(path);
        if (isTextFile) {
          await this.docManager.removeDoc(path);
          this._clearConflictLoserGuard(path);
        }
        this.binarySync.broadcastFileDelete(path, deletedAt);
        this.syncLogService?.addEntry("local-send", path, {
          hasSnapshot: false,
          details: { isText: isTextFile, reason: "delete" },
        });
        break;
      }

      case "rename": {
        if (!oldPath) break;
        const oldIsText = this.filter.isTextFile(oldPath);
        // Under its old name, so peers apply it to the note they have before
        // they move it.
        const editBefore =
          event.editedBeforeRename && oldIsText && this.filter.isTextFile(path) &&
          (await this._applyEditMadeBeforeRename(event, oldPath));
        await this._recordRename(oldPath, path);
        if (oldIsText && isTextFile) {
          await this.docManager.renameDoc(oldPath, path);
          this._moveConflictLoserGuard(oldPath, path);
        } else if (oldIsText) {
          await this.docManager.removeDoc(oldPath);
          this._clearConflictLoserGuard(oldPath);
        }
        this.binarySync.broadcastFileRename(oldPath, path);
        // An attachment's change (or a text file's that is not plain UTF-8)
        // is sent as the whole file, under its new name.
        if (event.editedBeforeRename && !editBefore) {
          await this.binarySync.broadcastFileChange(path);
        }
        break;
      }
    }
  }

  /**
   * Apply a change made to a note just before it was renamed (see
   * VaultWatcher). The file is already under its new name. Returns false
   * when the file is to be sent as bytes instead (see isPlainUtf8).
   */
  private async _applyEditMadeBeforeRename(event: FileChangeEvent, oldPath: string): Promise<boolean> {
    const fromEditor = typeof event.content === "string";
    const content = fromEditor ? (event.content as string) : await this._readTextFile(event.path);
    if (content === null) return false;
    if (this._isEchoOfRemoteWrite(oldPath, content)) return true;
    await this.docManager.applyLocalChange(oldPath, content, !fromEditor);
    if (fromEditor && event.savedToDisk) {
      const onDisk = await this._readTextFile(event.path);
      if (onDisk !== null) this.docManager.noteDiskContent(oldPath, onDisk);
    }
    return true;
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
        // The doc must not keep the text either: if the note is put back
        // on the peer, fetching it again has to write it here.
        await this.docManager.removeDoc(filePath);
        return;
      }
      if (!isExistingFile && this._wasMovedOn(filePath, await this._hashText(latestContent))) {
        logger.debug(`Not restoring a copy its device moved on: ${filePath}`);
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
        // Bytes that are not plain UTF-8 are backed up as they are.
        const diskBytes = (await this._isPlainText(file, diskContent))
          ? null
          : new Uint8Array(await this.vault.readBinary(file));
        if (diskBytes || diskContent !== latestContent) {
          contentChanged = true;
          const needsBackup =
            diskBytes !== null ||
            (typeof previousContent === "string"
              ? diskContent !== previousContent
              : true); // previousContent unknown → always back up to be safe
          if (needsBackup) {
            const details = {
              previousContent: previousContent ?? "(unknown)",
              mergedContent: latestContent,
            };
            const backup = diskBytes
              ? await this.backupService.backupBinaryFile(filePath, diskBytes, "text-remote-overwrite", details)
              : await this.backupService.backupTextFile(filePath, diskContent, "text-remote-overwrite", details);
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
      if (!(file instanceof TFile) && (await this._refuseCaseClash(filePath))) return;
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
      await this._markWritten(filePath, latest, false);
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
    // What changed while sync was not running is known first.
    await this.primed;
    const localTree = await this._buildTree();
    const isInitialBootstrap = this.pendingInitialBootstrapPeers.has(deviceId);
    const remoteFiles = new Map<string, (typeof meta.files)[number]>();
    for (const f of meta.files) {
      // Never pull files this device ignores (or cannot safely write).
      if (!this._isAllowedPath(f.path, true)) continue;
      remoteFiles.set(f.path, f);
    }

    // Files the peer put back after a deletion (see TombstoneStore.revive):
    // our record of that deletion no longer holds. Kept, for peers that
    // only meet us, as long as the file is around.
    for (const f of remoteFiles.values()) {
      if (!f.revives || typeof f.revives.deletedAt !== "number") continue;
      const ours = this.tombstones.get(f.path);
      if (ours && !ours.movedTo && ours.deletedAt <= f.revives.deletedAt) this.tombstones.clear(f.path);
      if (!this.tombstones.get(f.path)) this.tombstones.noteRevival(f.path, f.revives.deletedAt, f.revives.hash);
    }

    const treeDiff = diffFileTrees(localTree.files, remoteFiles);
    // Settled again below for the notes that still differ.
    this._forgetHistoryWinners(deviceId);
    const remoteDeleted = new Map((meta.deleted ?? []).map((t) => [t.path, t]));
    // The peer gave a file the same name we did, later: keep the later
    // time, which is what other renames of the file are weighed against.
    for (const theirs of remoteDeleted.values()) {
      const ours = theirs.movedTo ? this.tombstones.get(theirs.path) : undefined;
      if (ours && ours.movedTo === theirs.movedTo && ours.hash && ours.hash === theirs.hash && theirs.deletedAt > ours.deletedAt) {
        this.tombstones.add(ours.path, ours.hash, theirs.deletedAt, ours.movedTo);
      }
    }

    // Where names that differ only in case are one file, a peer's file
    // whose name is another case of one of ours cannot be stored next to it.
    const localByCase = treeDiff.remoteOnly.length > 0 && (await this._isCaseInsensitiveFs())
      ? new Map([...localTree.files.keys()].map((p) => [p.toLowerCase(), p]))
      : null;

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
        this.connectionManager.sendTo(
          deviceId,
          encodeFileDelete({ path: file.path, deletedAt: this.tombstones.get(file.path)?.deletedAt }),
        );
        this._emitEvent(`Deleted while sync was off: ${file.path}`);
        continue;
      }
      const sameFile = localByCase?.get(file.path.toLowerCase());
      // A note renamed here keeps taking edits made under its old name (see
      // _applyToRenamed); anything else would be written over our file.
      if (sameFile && sameFile !== file.path && !(ownTombstone?.movedTo && file.isTextFile)) {
        // One of us renamed the file to the other's name: the peer follows
        // our rename, and we follow theirs below.
        if (ownTombstone?.movedTo || remoteDeleted.get(sameFile)?.movedTo === file.path) continue;
        this._reportUnsyncable(file.path, this._caseClashReason(sameFile));
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

    // A rename or deletion was settled here: other peers (and this one)
    // may now have something to follow, told right away.
    let settled = false;

    // Files only locally — send them to the specific peer
    for (const file of treeDiff.localOnly) {
      // The peer deleted this file while we were away.
      const peerTombstone = remoteDeleted.get(file.path);
      // Renamed on the peer to another case of its name: deleting the old
      // name would delete the very file where such names are one file.
      const caseTarget = peerTombstone?.movedTo ? this._renameTarget(peerTombstone, remoteFiles, remoteDeleted) : null;
      if (caseTarget && isCaseVariant(file.path, caseTarget)) {
        await this._followRemoteRename(deviceId, file.path, caseTarget, peerTombstone);
        continue;
      }
      // Put back here after that very deletion: the peer drops its record
      // when it sees ours, and gets the file.
      const revival = this.tombstones.getRevival(file.path);
      const revived = !!revival && !!peerTombstone && !peerTombstone.movedTo && peerTombstone.deletedAt <= revival.deletedAt;
      if (peerTombstone && !revived && TombstoneStore.covers(peerTombstone, file)) {
        await this.binarySync.applyRemoteDelete(file.path, peerTombstone);
        this._emitEvent(`Deleted (removed on ${deviceId}): ${file.path}`);
        continue;
      }
      // We moved this file, and the peer deleted it later, unchanged.
      const deletedLater = this._deletedAfterRename(file, this.tombstones.list(), (p) => remoteDeleted.get(p));
      if (deletedLater) {
        settled = true;
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
        settled = true;
        // Take on the rename that won, so that a third device which renamed
        // the note too compares with it and not with our own, older one.
        if (later) {
          const t = later.theirs;
          this.tombstones.add(t.path, t.hash, t.deletedAt, t.movedTo);
        }
        continue;
      }
      if (this._needNotSend(deviceId, file)) continue;
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
      // A text file that is not plain UTF-8 on either side is compared as
      // bytes, which also switches the other copy over to that.
      if (local.isTextFile && remote.isTextFile) {
        const decision = this._decideConflict(deviceId, local, remote);
        this.historyWinners.set(this._peerPathKey(deviceId, local.path), decision);
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
          await this._takeMissedLocalEdit(local.path);
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

          if (decision.localWins) {
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
            if (localFile instanceof TFile && decision.keepCopy) {
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
    if (settled) this._scheduleTreeSync();

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

  /**
   * Files sent to a peer because its file list lacked them, by peer and
   * path: the hash sent and when. A device that is slow to take in a bulk
   * change sends its list while our files are still queued for it, and
   * sending them all again each round only made its queue longer. The peer
   * asks for whatever it still lacks itself; this is forgotten when the
   * connection drops.
   */
  private sentToPeers = new Map<string, { hash: string; at: number }>();
  private static readonly RESEND_AFTER_MS = 5 * 60 * 1000;

  /**
   * Whether a file the peer lacks need not be sent to it: sent a moment ago
   * (see sentToPeers), or gone here since the file list was made. Tree syncs
   * with several peers run at once, and one of them may delete or move the
   * file meanwhile: sent anyway, a note came back on the peer from its doc.
   */
  private _needNotSend(deviceId: string, file: FileMeta): boolean {
    if (!(this.vault.getAbstractFileByPath(file.path) instanceof TFile)) return true;
    const key = this._peerPathKey(deviceId, file.path);
    const sent = this.sentToPeers.get(key);
    const now = Date.now();
    if (sent && sent.hash === file.hash && now - sent.at < SyncCoordinator.RESEND_AFTER_MS) return true;
    if (this.sentToPeers.size >= 20000) this.sentToPeers.clear();
    this.sentToPeers.set(key, { hash: file.hash, at: now });
    return false;
  }

  private _forgetSent(deviceId: string): void {
    const prefix = `${deviceId}\n`;
    for (const key of this.sentToPeers.keys()) {
      if (key.startsWith(prefix)) this.sentToPeers.delete(key);
    }
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
    // Missing, or not plain UTF-8: its text as a string is not its content.
    const diskContent = await this._readTextFile(filePath);
    if (diskContent === null) return;
    await this.docManager.initDocFromContentSilent(filePath, diskContent);
  }

  /**
   * Apply a change to a note's file that never reached its doc. A loaded doc
   * is trusted over the file, so when an edit was missed (its event was
   * lost), syncing with a peer exchanged identical docs while the files
   * kept differing, round after round, until the note was edited again.
   */
  private async _takeMissedLocalEdit(filePath: string): Promise<void> {
    const known = this.docManager.getWrittenContent(filePath);
    if (known === undefined) return;
    const disk = await this._readTextFile(filePath);
    if (disk === null || disk === known) return;
    // An editor's own events carry what is typed there; its file may lag.
    if (this._openEditors(filePath).some((editor) => editor.getValue() !== disk)) return;
    if (this.watcher.hasPendingModify(filePath) || this.remoteWriteQueues.has(filePath)) return;
    if (disk === (await this.docManager.getContent(filePath))) {
      this.docManager.markWritten(filePath, disk, true);
      return;
    }
    this.knownHashes.set(filePath, await this._hashText(disk));
    await this.docManager.applyLocalChange(filePath, disk, true);
    this._emitEvent(`Picked up a change that was not synced: ${filePath}`);
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
    const fromEditor = typeof pending.content === "string";
    const content = fromEditor
      ? (pending.content as string)
      : await this._readTextFile(filePath);
    if (content === null) {
      if (await this._holdsNonUtf8(filePath)) await this._sendTextAsBytes(filePath);
      return false;
    }
    if (this._isEchoOfRemoteWrite(filePath, content)) {
      await this._noteDiskText(filePath, fromEditor, pending.savedToDisk, content);
      return false;
    }

    await this.docManager.applyLocalChange(filePath, content, !fromEditor);
    await this._noteDiskText(filePath, fromEditor, pending.savedToDisk);
    return true;
  }

  /**
   * Tell the doc manager what the note's file holds after a local change:
   * the text just read from it, or, for a change taken from an editor, the
   * file as Obsidian saved it meanwhile. A change read from the file that
   * was applied has been told already.
   */
  private async _noteDiskText(
    filePath: string,
    fromEditor: boolean,
    savedToDisk: boolean | undefined,
    readFromFile?: string,
  ): Promise<void> {
    if (!fromEditor) {
      if (readFromFile !== undefined) this.docManager.noteDiskContent(filePath, readFromFile);
      return;
    }
    if (!savedToDisk) return;
    const onDisk = await this._readTextFile(filePath);
    if (onDisk !== null) this.docManager.noteDiskContent(filePath, onDisk);
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

  /**
   * Exchange file lists with every peer soon, instead of at the next
   * periodic sync: after a change that a peer only learns of from our list
   * (a file put back after a deletion), or after settling a rename or
   * deletion conflict, which may leave the peer something to follow.
   */
  private _scheduleTreeSync(): void {
    if (this.treeSyncTimer || !this.running) return;
    this.treeSyncTimer = setTimeout(() => {
      this.treeSyncTimer = null;
      if (this.running) void this._periodicFullSync().catch((err) => logger.warn("File list exchange failed:", err));
    }, SyncCoordinator.TREE_SYNC_DELAY_MS);
  }

  private static readonly TREE_SYNC_DELAY_MS = 500;

  // ─── Private: Helpers ───────────────────────────────────

  private async _buildTree(): Promise<FileTreeSnapshot> {
    // Unchanged files keep their hash, so the periodic sync does not read
    // the whole vault every time.
    const tree = await buildFileTree(this.vault, this.filter, this.hashCache);
    for (const [path, meta] of tree.files) {
      this.knownHashes.set(path, meta.hash);
      // Peers could not store it; see _unportableName.
      if (this._unportableName(path)) { tree.files.delete(path); continue; }
      const revival = this.tombstones.getRevival(path);
      if (revival) {
        const revives = revival.hash ? { deletedAt: revival.deletedAt, hash: revival.hash } : { deletedAt: revival.deletedAt };
        tree.files.set(path, { ...meta, revives });
      }
      if (meta.isTextFile) {
        const crdt = await this.docManager.crdtDigest(path);
        const current = tree.files.get(path)!;
        tree.files.set(path, crdt ? { ...current, crdt } : { ...current, crdt: undefined });
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
      if (this._folderDeleted(path, (p) => (this.vault.getAbstractFileByPath(p) ? undefined : this.tombstones.get(p)))) continue;
      await this._createFolderFromRemote(path);
    }
    for (const path of this._listFolders()) {
      if (remote.has(path)) continue;
      if (this._folderDeleted(path, (p) => (remote.has(p) ? undefined : remoteDeleted.get(p)))) this._scheduleFolderDelete(path);
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

  /**
   * Whether a folder, or a folder it is in, was deleted according to these
   * deletion records (`deletionOf` leaves out folders that are still there).
   * A device may record only the outermost folder of the ones it deleted:
   * its subfolders were then brought back from peers that still listed
   * them, and stayed, empty, on every device.
   */
  private _folderDeleted(path: string, deletionOf: (path: string) => { hash?: string } | undefined): boolean {
    for (let at = path.length; at > 0; at = path.lastIndexOf("/", at - 1)) {
      if (deletionOf(path.slice(0, at))?.hash === FOLDER_HASH) return true;
    }
    return false;
  }

  /**
   * How long a folder a peer deleted waits for its files to go, counted
   * from the last deletion or rename that came in. A slow device takes
   * minutes to delete a large folder's files after the folder's own
   * deletion, from either end: when the wait was counted from the folder's
   * deletion, it ran out first and the folder was left behind, empty.
   */
  private static FOLDER_DELETE_WAIT_MS = 60_000;

  private _scheduleFolderDelete(path: string): void {
    // Files inside may still be on their way out (moved or deleted by the
    // same change), so keep trying for a while.
    this.pendingFolderDeletes.set(path, Date.now() + SyncCoordinator.FOLDER_DELETE_WAIT_MS);
    void this._prunePendingFolders();
  }

  private async _prunePendingFolders(): Promise<void> {
    // Deepest first, so a parent is checked after its subfolders are gone.
    const paths = [...this.pendingFolderDeletes.keys()].sort((a, b) => b.length - a.length);
    const now = Date.now();
    for (const path of paths) {
      const expiry = this.pendingFolderDeletes.get(path);
      if (expiry === undefined) continue;
      const folder = this.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder) || expiry < now) {
        this.pendingFolderDeletes.delete(path);
        continue;
      }
      // Deletions are still coming in: the files may be among them.
      this.pendingFolderDeletes.set(path, Math.max(expiry, now + SyncCoordinator.FOLDER_DELETE_WAIT_MS));
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
        // Deleted while the list was being read: its events have been seen.
        if (!(this.vault.getAbstractFileByPath(path) instanceof TFile)) continue;
        // A change seen meanwhile already recorded a newer hash.
        if (!this.knownHashes.has(path)) this.knownHashes.set(path, meta.hash);
        // Put back while sync was not running.
        if (this.tombstones.get(path)) this.tombstones.revive(path);
      }
      await this._findRenamesWhileStopped(tree.files);
    } catch (err) {
      logger.warn("Could not read file hashes at start:", err);
    }
  }

  /**
   * Files renamed while sync was not running (app closed, sync turned off):
   * a name from when sync last ran is gone, and a new name holds the same
   * content. Recorded as renames, as if seen when made, so that peers move
   * their copies, and a rename of the same file made elsewhere meanwhile is
   * weighed against this one (the later wins) instead of both names being
   * kept. When it was made is not known; the time it is found counts.
   */
  private async _findRenamesWhileStopped(files: Map<string, FileMeta>): Promise<void> {
    const byHash = (entries: Iterable<[string, string]>) => {
      const out = new Map<string, string[]>();
      for (const [path, hash] of entries) out.set(hash, [...(out.get(hash) ?? []), path]);
      return out;
    };
    const gone = byHash(
      [...this.lastRunFiles].filter(([path]) => !files.has(path) && !this.vault.getAbstractFileByPath(path) && !this.tombstones.get(path)),
    );
    if (gone.size === 0) return;
    const added = byHash(
      [...files.values()]
        .filter((f) => !this.lastRunFiles.has(f.path) && gone.has(f.hash) && this.vault.getAbstractFileByPath(f.path) instanceof TFile)
        .map((f) => [f.path, f.hash] as [string, string]),
    );
    for (const [hash, oldPaths] of gone) {
      const newPaths = added.get(hash);
      // Only where it is clear which file went where.
      if (oldPaths.length !== 1 || newPaths?.length !== 1) continue;
      const [oldPath] = oldPaths;
      const [newPath] = newPaths;
      if (this.filter.isTextFile(oldPath) !== this.filter.isTextFile(newPath)) continue;
      this.lastRunFiles.delete(oldPath);
      this.tombstones.add(oldPath, hash, undefined, newPath);
      if (this.filter.isTextFile(oldPath)) await this.docManager.renameDoc(oldPath, newPath);
      this._emitEvent(`Renamed while sync was off: ${oldPath} -> ${newPath}`);
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
  private async _markWritten(filePath: string, content: string, onDisk = true): Promise<void> {
    this.docManager.markWritten(filePath, content, onDisk);
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
    // A failure (the file was deleted meanwhile, say) leaves both names as
    // they are; it must not end the tree sync that asked for the rename.
    const run = this.renameFollowQueue
      .then(() => this._followRemoteRenameNow(deviceId, oldPath, newPath, record))
      .catch((err) => {
        logger.warn(`Could not follow rename ${oldPath} -> ${newPath}:`, err);
        return false;
      });
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

  private static readonly MOVED_ON_MS = 5 * 60 * 1000;

  /**
   * A peer told that it moved its copy of `path` (with this content) on to
   * the note's new name, while we hold our own record for `path`, which
   * stays as it is. The copy may still be on its way to us from before:
   * arriving after the notice, it found nothing that said where it went and
   * was kept under the old name, next to the note it was merged into.
   */
  private _rememberMovedOn(path: string, hash: string): void {
    const now = Date.now();
    if (this.movedOnCopies.size > 500) {
      for (const [p, copies] of this.movedOnCopies) {
        for (const [h, at] of copies) if (now - at > SyncCoordinator.MOVED_ON_MS) copies.delete(h);
        if (copies.size === 0) this.movedOnCopies.delete(p);
      }
    }
    const copies = this.movedOnCopies.get(path) ?? new Map<string, number>();
    copies.set(hash, now);
    this.movedOnCopies.set(path, copies);
  }

  private _wasMovedOn(path: string, hash: string): boolean {
    const at = this.movedOnCopies.get(path)?.get(hash);
    return at !== undefined && Date.now() - at <= SyncCoordinator.MOVED_ON_MS;
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
    let isText = this.filter.isTextFile(oldPath);
    if (!this._isAllowedPath(newPath) || this.filter.isTextFile(newPath) !== isText) return false;
    const file = this.vault.getAbstractFileByPath(oldPath);
    // Already followed, e.g. for another peer a moment ago.
    if (!(file instanceof TFile)) return this.tombstones.get(oldPath)?.movedTo === newPath;
    // A text file synced as bytes (see isPlainUtf8) moves like an attachment.
    if (isText && (await this._holdsNonUtf8(oldPath))) isText = false;
    // Only the case of the name changes: the same file, renamed in place.
    // Nothing is merged, so no shared history is needed.
    const caseOnly = isCaseVariant(oldPath, newPath);
    // We deleted the new name ourselves; don't bring it back.
    if (this.tombstones.get(newPath) && !caseOnly) return false;
    if (isText) {
      if (!caseOnly && !(await this.docManager.hasDocState(oldPath))) return false;
      await this._flushPendingLocalTextChange(oldPath);
      if (!caseOnly) await this._ensureCrdtInitialized(oldPath);
    }
    const oldHash = await computeFileHash(await this.vault.readBinary(file));

    const target = caseOnly ? null : this.vault.getAbstractFileByPath(newPath);
    // The peer's text for the new name may have arrived before its file is
    // written. Our file must not take that name then: the pending write
    // would put the peer's text over it, without our edits.
    const peerDocArrived = isText && !target && !caseOnly && (await this.docManager.hasDocState(newPath));
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
      await this.binarySync.renameInVault(file, newPath);
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
    this.lastRunFiles.delete(oldPath);
    if (hash) this.knownHashes.set(newPath, hash);
  }

  /**
   * A file changed here while we hold a record of its deletion: it was put
   * back (see TombstoneStore.revive). Peers learn of it from our file list,
   * sent soon so they stop refusing it.
   */
  private _reviveIfDeleted(path: string): void {
    if (!this.tombstones.get(path)) return;
    this.tombstones.revive(path);
    if (this.tombstones.getRevival(path)) this._scheduleTreeSync();
  }

  /** Tell the user, once, that a file cannot be synced and why. */
  private _reportUnsyncable(path: string, reason: string): void {
    if (this.reportedUnsyncable.has(path)) return;
    this.reportedUnsyncable.add(path);
    logger.warn(`Cannot sync ${path}: ${reason}`);
    this._emitEvent(`Cannot sync ${path}: ${reason}`);
    this.onUnsyncableCb?.(path, reason);
  }

  private _caseClashReason(existing: string): string {
    return `"${existing}" is here already, and names that differ only in case are the same file on this device`;
  }

  /**
   * Whether a peer's new file must not be created here because a file whose
   * name differs only in case exists, which is the same file on this
   * device. Created anyway, it would fail, or write over that file.
   */
  private async _refuseCaseClash(path: string): Promise<boolean> {
    if (!(await this._isCaseInsensitiveFs())) return false;
    const lower = path.toLowerCase();
    const existing = this.vault.getFiles().find((f) => f.path !== path && f.path.toLowerCase() === lower);
    if (!existing) return false;
    this._reportUnsyncable(path, this._caseClashReason(existing.path));
    // The peer's text for it, if that is what came: kept, it would make the
    // note's next fetch, once the name is free, bring nothing new to write.
    await this.docManager.removeDoc(path);
    return true;
  }

  /**
   * Whether the vault's storage takes names that differ only in case for the
   * same file. Found out once, by asking for an existing name in another
   * case: the config folder, or else any file.
   */
  private _isCaseInsensitiveFs(): Promise<boolean> {
    if (!this.caseInsensitive) {
      const probing = this._probeCaseInsensitive();
      this.caseInsensitive = probing.then((answer) => {
        // Nothing to ask about yet; ask again later.
        if (answer === null) this.caseInsensitive = null;
        return answer === true;
      });
    }
    return this.caseInsensitive;
  }

  private async _probeCaseInsensitive(): Promise<boolean | null> {
    const adapter = (this.vault as any).adapter;
    if (!adapter?.exists) return null;
    const swap = (p: string) => [...p].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
    try {
      const configDir: string = (this.vault as any).configDir ?? ".obsidian";
      if (swap(configDir) !== configDir && (await adapter.exists(configDir))) {
        return await adapter.exists(swap(configDir));
      }
      for (const file of this.vault.getFiles()) {
        const other = swap(file.path);
        if (other === file.path || this.vault.getAbstractFileByPath(other)) continue;
        return await adapter.exists(other);
      }
    } catch (err) {
      logger.debug("Could not tell whether file names are case-sensitive:", err);
    }
    return null;
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

  /**
   * A text file's content, or null when it is missing or is not plain UTF-8
   * (see isPlainUtf8): as a string, such a file is not what it holds.
   */
  private async _readTextFile(path: string): Promise<string | null> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return null;
    }

    const text = await this.vault.cachedRead(file);
    return (await this._isPlainText(file, text)) ? text : null;
  }

  /**
   * Whether a file read as `text` is plain UTF-8. A file that is not reads
   * with replacement characters, or with a different length (a byte order
   * mark is dropped); only then are its bytes read to make sure.
   */
  private async _isPlainText(file: TFile, text: string): Promise<boolean> {
    if (text.charCodeAt(0) === 0xfeff) return false;
    if (!text.includes("\ufffd") && utf8Length(text) === file.stat.size) return true;
    return isPlainUtf8(new Uint8Array(await this.vault.readBinary(file)));
  }

  private async _holdsNonUtf8(path: string): Promise<boolean> {
    const file = this.vault.getAbstractFileByPath(path);
    return file instanceof TFile && !isPlainUtf8(new Uint8Array(await this.vault.readBinary(file)));
  }

  /**
   * Send a changed text file that is not plain UTF-8 as bytes, like an
   * attachment: as a string it would reach peers changed (an encoding
   * turned into replacement characters, a byte order mark dropped).
   */
  private async _sendTextAsBytes(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const hash = await computeFileHash(await this.vault.readBinary(file));
    // The modify event of a peer's bytes written here.
    if (this.remoteWrittenBytes.get(path) === hash) return;
    this.remoteWrittenBytes.delete(path);
    this._reviveIfDeleted(path);
    this.knownHashes.set(path, hash);
    await this._dropTextHistory(path);
    await this.binarySync.broadcastFileChange(path);
  }

  /**
   * A text file was written from a peer's bytes (see
   * BinaryFileSyncService._receiveFile).
   */
  private async _storedTextAsBytes(path: string, hash: string, content: Uint8Array, fromDeviceId?: string): Promise<void> {
    if (!isPlainUtf8(content)) {
      this.remoteWrittenBytes.set(path, hash);
      await this._dropTextHistory(path);
      return;
    }
    // Plain text with no history here (a note that had been synced as
    // bytes, or one that got text after it was listed as empty): take the
    // sender's history. One started from the file here would not merge
    // with it.
    if (content.length === 0 || !fromDeviceId || (await this.docManager.hasDocState(path))) return;
    this._addConflictLoserGuard(path, fromDeviceId);
    this.connectionManager.sendTo(
      fromDeviceId,
      encodeYjsSync(MessageType.YJS_SYNC_STEP1, path, Y.encodeStateVector(new Y.Doc())),
    );
  }

  /** A text file now synced as bytes: its doc no longer describes it. */
  private async _dropTextHistory(path: string): Promise<void> {
    if (!(await this.docManager.hasDocState(path))) return;
    await this.docManager.removeDoc(path);
    this._clearConflictLoserGuard(path);
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
    const decision = this.historyWinners.get(this._peerPathKey(deviceId, filePath));
    const result = await this.docManager.applyFullState(filePath, update, deviceId, decision?.localWins);
    if (result === "kept-local") {
      // Our doc wins; send it so the peer adopts it.
      await this._sendFullTextState(deviceId, filePath, "Resolving unrelated history");
    } else if (result === "adopted") {
      // The note we had came from another history and is now replaced.
      if (decision?.keepCopy !== false && before !== (await this.docManager.getContent(filePath))) {
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
   * our files are filtered the same way as local changes), and its name one
   * that every device can store (see _unportableName), which `report` tells
   * the user about when it is not.
   */
  private _isAllowedPath(filePath: string, report = false): boolean {
    if (this.filter.shouldIgnore(filePath)) return false;
    // Before the safety check, which refuses some of these names too ("a:b.md"
    // looks like a drive letter), so that they are reported.
    if (report ? this._unportableName(filePath) : unportableNameChars(filePath)) return false;
    return isSafeSyncPath(filePath);
  }

  /**
   * Whether a file is left out of sync for its name, telling the user once.
   * Such a file, made outside Obsidian, reached no other device: each one
   * failed to create it, and asked for it again at every round.
   */
  private _unportableName(filePath: string): boolean {
    const chars = unportableNameChars(filePath);
    if (!chars) return false;
    this._reportUnsyncable(filePath, `its name contains ${chars}, which Obsidian does not allow in file names on most devices. Rename it to sync it`);
    return true;
  }

  /**
   * Which copy of a note to keep when the copies here and on the peer differ
   * and may not share a history, so that a merge is not possible. Both
   * devices decide from the same two file entries, so they agree: the copy
   * modified later wins, and the other is kept as a conflict copy. The
   * random Yjs client IDs used to decide this, so an old copy could replace
   * a newer edit.
   */
  private _decideConflict(
    deviceId: string,
    local: FileMeta,
    remote: FileMeta,
  ): { localWins: boolean; keepCopy: boolean } {
    // One side deleted the very copy the other still has, and then made a
    // new note under the name (see TombstoneStore.revive): the new note
    // wins, and the deleted copy is not kept again as a conflict copy.
    const ours = this.tombstones.getRevival(local.path);
    if (ours?.hash && ours.hash === remote.hash) return { localWins: true, keepCopy: false };
    if (remote.revives?.hash && remote.revives.hash === local.hash) return { localWins: false, keepCopy: false };
    return { localWins: this._isConflictWinner(local.mtime, remote.mtime, deviceId), keepCopy: true };
  }

  private _peerPathKey(deviceId: string, path: string): string {
    return `${deviceId}\n${path}`;
  }

  private _forgetHistoryWinners(deviceId: string): void {
    const prefix = `${deviceId}\n`;
    for (const key of this.historyWinners.keys()) {
      if (key.startsWith(prefix)) this.historyWinners.delete(key);
    }
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
