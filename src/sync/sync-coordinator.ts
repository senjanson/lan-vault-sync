import { Vault, TAbstractFile, TFile, TFolder, Workspace } from "obsidian";
import * as Y from "yjs";
import fastDiff from "fast-diff";
import { AuthFailure, ConnectionManager } from "../transport/connection-manager";
import {
  encodeYjsSync,
  decodeYjsSync,
  encodeSyncStep1Data,
  decodeSyncStep1Data,
  encodeFullStateData,
  decodeFullStateData,
  AdoptedHistory,
  ApartText,
  encodeFileMetaSync,
  encodeFolderOp,
  encodeFileDelete,
  decodeJSON,
} from "../transport/protocol";
import { YjsDocManager } from "../crdt/yjs-doc-manager";
import { hasLineFromNeither } from "../crdt/text-diff";
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
import { AGREED_HASHES_FILE, FILE_INDEX_FILE } from "../constants";
import { ensureParentDirectory, ensureVaultParentFolder, isCaseVariant, isSafeSyncPath, unportableNameChars } from "../utils/path-utils";
import { supportsIncomingConnections } from "../utils/runtime";
import { parsePeerAddress } from "../discovery/manual-peers";
import { isPlainUtf8, utf8Length } from "../utils/utf8";

/** Hash recorded in deletion records of folders. */
const FOLDER_HASH = "folder";

/** AGREED_HASHES_FILE; see SyncCoordinator._agreedHashesToSave. */
interface SavedAgreedHashes {
  version: 2;
  /** Peers by device ID, and when each last sent its file list. */
  peers: Array<{ id: string; seen: number }>;
  /** Per note: the hash shared with every peer, or one per peer (null: none). */
  files: Record<string, string | Array<string | null>>;
  /** Per note: an earlier time learned for its current version; see FileMeta.madeAt. */
  times: Record<string, [string, number]>;
}

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
  /**
   * FileMeta.agreed of each note in a peer's last file list (the version it
   * last had in common with us), by peer and path; see _decideWithoutFileLists.
   */
  private peerAgreedHashes = new Map<string, string>();
  /**
   * Notes whose doc this device replaced a moment ago with a peer's
   * separate history and another text (see _applyFullState), by path: when,
   * and the hash of the text it had before. Such a doc carries a decision
   * made with that peer, and is sent marked as such (see
   * encodeFullStateData), so that peers that had the dropped history follow
   * it instead of settling it anew without a decision.
   */
  private recentAdoptions = new Map<string, { at: number; dropped: string }>();
  /**
   * The last pair of docs (ours and the peer's, by state vector) for which
   * our doc was sent back to a peer as the one to keep, and when, by peer
   * and path; see _applyFullState.
   */
  private resolvingSent = new Map<string, { pair: string; at: number }>();
  /** Whole docs from peers being applied, by path; see _applyFullState. */
  private fullStateQueues = new Map<string, Promise<void>>();
  /**
   * Notes that differed from a peer's copy when the two connected, by peer
   * and path: our text and the peer's as each side sent it (see
   * _settleApartEdits), until the peer's changes arrive.
   */
  private apartTexts = new Map<string, { ours?: ApartText; theirs?: ApartText; at: number }>();
  private localFileChangeQueue: Promise<void> = Promise.resolve();
  /**
   * Files deleted here whose deletion events are still queued (see
   * _enqueueLocalFileChange), by path: how many, and the record the latest
   * will get. The file is gone from the vault at once, but its deletion is
   * recorded only when its turn comes, which on a phone deleting a large
   * folder is many seconds later. A file list exchange meanwhile took those
   * files for ones this device lacks: it fetched them back from peers, and
   * peers sent them back, recreating their folders.
   */
  private pendingLocalDeletes = new Map<string, { count: number; record: Tombstone }>();
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
  /**
   * Per peer (by device ID) and note, the hash of the content this device
   * last had in common with that peer, sent to that peer as FileMeta.agreed.
   * Recorded only when the peer's file list shows the very same content, so
   * the peer certainly had it. Kept apart from the notes' sync history,
   * which can be lost on its own.
   *
   * Kept per peer: with one record per note, a list exchange with one
   * device moved it on to a version another device, away meanwhile, never
   * had; the two then named different versions and the note was settled by
   * modified times, which kept a needless conflict copy.
   */
  private agreedHashes = new Map<string, Map<string, string>>();
  /** When each peer in agreedHashes last sent its file list, to forget devices gone for good. */
  private agreedPeersSeen = new Map<string, number>();
  /**
   * Earlier times for notes' current versions, learned from peers listing
   * the same content (path → hash and time); see FileMeta.madeAt.
   */
  private versionTimes = new Map<string, { hash: string; at: number }>();
  /** agreedHashes, agreedPeersSeen or versionTimes changed since the last save. */
  private agreedHashesChanged = false;
  private agreedHashesSave: Promise<void> = Promise.resolve();
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
      await this._loadAgreedHashes();

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
    await this._saveAgreedHashes();

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
    await this._saveAgreedHashes();
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
      this._forgetApartTexts(deviceId);
      this._emitEvent(`Disconnected: ${deviceId}`);
      this.onStateChangeCb?.(this.stateMachine.getState());
    });

    // Incoming protocol messages, one at a time per peer (see
    // _deleteAlongside for the exception).
    this.connectionManager.onMessage(async (deviceId, type, payload) => {
      if (type === MessageType.FILE_DELETE) {
        const del = decodeJSON<FileDeletePayload>(payload);
        if (!del.hash && !del.movedTo && typeof del.path === "string") {
          await this._deleteAlongside(deviceId, del.path, () => this._handleMessage(deviceId, type, payload));
          return;
        }
      }
      await this._deletesSettled(deviceId);
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
    // A folder made to hold a peer's file: its create event is not the
    // user's. Taken as one, it cleared the record of the folder's deletion
    // here and was sent to every peer as a new folder, so a folder deleted
    // while a peer's file was on its way stayed, empty, on every device.
    this.binarySync.onRemoteFolderMade((path) => this.watcher.markRemoteWrite(path, "write"));
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
        const raw = decodeYjsSync(payload);
        if (!this._isAllowedPath(raw.filePath)) break;
        const { stateVector, apart } = decodeSyncStep1Data(raw.data);
        const msg = { filePath: raw.filePath, data: stateVector };
        await this._renameSettled(msg.filePath);
        const resolvedPath = this._resolveRecentRemoteTextRename(msg.filePath);
        if (apart) this._noteApartText(deviceId, resolvedPath, { theirs: apart });
        // Renamed here: the peer learns the new name from our file list. The
        // request carries a state vector, not changes to merge.
        if (this._renamedTextTarget(resolvedPath)) {
          this._takeApartTexts(deviceId, resolvedPath);
          break;
        }
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
        // Settled by keeping one whole doc; no merge for the texts sent at
        // connect to describe, and none to wait for.
        if (relation !== "related") this._takeApartTexts(deviceId, resolvedPath);
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
        await this._receiveRemoteUpdate(
          deviceId,
          resolvedPath,
          msg.data,
          this._takeApartTexts(deviceId, resolvedPath),
        );
        break;
      }

      case MessageType.YJS_FULL_STATE: {
        const msg = decodeYjsSync(payload);
        if (!this._isAllowedPath(msg.filePath)) break;
        await this._renameSettled(msg.filePath);
        const resolvedPath = this._resolveRecentRemoteTextRename(msg.filePath);
        // The peer answered with its whole doc (separate histories, say):
        // the texts exchanged for this note are not about this.
        this._takeApartTexts(deviceId, resolvedPath);
        await this._flushPendingLocalTextChange(resolvedPath);
        if (!this._hasConflictLoserGuard(resolvedPath)) {
          await this._ensureCrdtInitialized(resolvedPath);
        }
        const { update, adopted } = decodeFullStateData(msg.data);
        await this._applyFullState(deviceId, resolvedPath, update, adopted);
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
          const reply = this._encodeTree(metaList, deviceId, true);
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

  /**
   * Deletions a peer sent that are being applied, by peer and path. A peer
   * deleting a folder sends a deletion per file, and applying one (backup,
   * delete, saved history) is several round trips to a phone's storage;
   * taken one at a time they took minutes. A few are applied at once; any
   * other message from the peer waits until they are done, so it sees them
   * all applied, as before. Deletions of one path are taken in order.
   */
  private peerDeletes = new Map<string, Map<string, Promise<void>>>();
  private static readonly PARALLEL_DELETES = 4;

  private async _deleteAlongside(deviceId: string, path: string, apply: () => Promise<void>): Promise<void> {
    let running = this.peerDeletes.get(deviceId);
    if (!running) {
      running = new Map();
      this.peerDeletes.set(deviceId, running);
    }
    await running.get(path);
    while (running.size >= SyncCoordinator.PARALLEL_DELETES) await Promise.race(running.values());
    const run: Promise<void> = apply()
      .catch((err) => logger.error(`Error handling a deletion from ${deviceId}:`, err))
      .finally(() => {
        if (running!.get(path) === run) running!.delete(path);
      });
    running.set(path, run);
  }

  private async _deletesSettled(deviceId: string): Promise<void> {
    const running = this.peerDeletes.get(deviceId);
    while (running && running.size > 0) await Promise.all(running.values());
  }

  // ─── Private: Local file changes ────────────────────────

  private _enqueueLocalFileChange(event: FileChangeEvent): Promise<void> {
    const settled = event.type === "delete" ? this._notePendingLocalDelete(event) : null;
    const run = async () => {
      try {
        await this._handleLocalFileChange(event);
      } finally {
        settled?.();
      }
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

  /**
   * Note a deletion made here that is waiting its turn in the queue (see
   * pendingLocalDeletes); returns what to call once it is handled.
   */
  private _notePendingLocalDelete(event: FileChangeEvent): () => void {
    const { path } = event;
    const hash = this.knownHashes.get(path);
    const record: Tombstone = hash
      ? { path, hash, deletedAt: event.timestamp }
      : { path, deletedAt: event.timestamp };
    const pending = this.pendingLocalDeletes.get(path);
    if (pending) {
      pending.count++;
      pending.record = record;
    } else {
      this.pendingLocalDeletes.set(path, { count: 1, record });
    }
    return () => {
      const p = this.pendingLocalDeletes.get(path);
      if (p && --p.count <= 0) this.pendingLocalDeletes.delete(path);
    };
  }

  /** Deleted here, with the deletion still waiting to be recorded. */
  private _localDeletePending(path: string): boolean {
    return this.pendingLocalDeletes.has(path) && !this.vault.getAbstractFileByPath(path);
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
        await ensureVaultParentFolder(this.vault as any, filePath, (folder) => this.watcher.markRemoteWrite(folder, "write"));
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
      const msg = this._encodeTree(metaList, deviceId);
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
    this._noteAgreedHashes(deviceId, localTree.files, remoteFiles);
    // Settled again below for the notes that still differ.
    this._forgetHistoryWinners(deviceId);
    for (const f of remoteFiles.values()) {
      if (f.isTextFile && typeof f.agreed === "string") this.peerAgreedHashes.set(this._peerPathKey(deviceId, f.path), f.agreed);
    }
    const remoteDeleted = new Map((meta.deleted ?? []).map((t) => [t.path, t]));
    // The peer's records of renames, by the name the file went to, so each
    // file is checked against its own renames instead of against them all.
    const remoteRenamesTo = new Map<string, Tombstone[]>();
    for (const t of remoteDeleted.values()) {
      if (!t.movedTo) continue;
      const renames = remoteRenamesTo.get(t.movedTo);
      if (renames) renames.push(t);
      else remoteRenamesTo.set(t.movedTo, [t]);
    }
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
      // Just deleted here: the deletion goes to the peer as soon as it is
      // recorded (see pendingLocalDeletes).
      if (this._localDeletePending(file.path)) {
        this._emitEvent(`Skipping deleted file: ${file.path}`);
        continue;
      }
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
      const deleted = this._deletedAfterRename(file, remoteRenamesTo.get(file.path) ?? [], (p) => this.tombstones.get(p));
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
      const deletedLater = this._deletedAfterRename(file, this.tombstones.renamesTo(file.path), (p) => remoteDeleted.get(p));
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
          // Just connected: the note was changed here or there (or both)
          // while the devices were apart. Our text goes with the request,
          // for the peer to settle edits of the same lines (see
          // _settleApartEdits); it sends us its own. With it goes when our
          // version was made, the same on every device that has it, so that
          // each device that meets the other version weighs the two alike
          // (see _decideConflict).
          let apart: ApartText | undefined;
          if (isInitialBootstrap) {
            apart = { text: await this.docManager.getContent(local.path), mtime: local.madeAt ?? local.mtime };
            this._noteApartText(deviceId, local.path, { ours: apart });
          }
          const msg = encodeYjsSync(
            MessageType.YJS_SYNC_STEP1,
            local.path,
            encodeSyncStep1Data(stateVector, apart),
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
    const data = encodeFullStateData(update, this._adoptedRecently(filePath));
    const msg = encodeYjsSync(MessageType.YJS_FULL_STATE, filePath, data);
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

      const msg = this._encodeTree(metaList, peerId);
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
    for (const peerId of peers) {
      this.connectionManager.sendTo(peerId, this._encodeTree(metaList, peerId));
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
        // The time this version was made: the file's own, or an earlier one
        // a peer listing the same content gave (see FileMeta.madeAt). One
        // learned for content we no longer have does not apply to any other.
        const learned = this.versionTimes.get(path);
        if (learned && learned.hash !== meta.hash) {
          this.versionTimes.delete(path);
          this.agreedHashesChanged = true;
        }
        const madeAt = learned && learned.hash === meta.hash ? Math.min(learned.at, meta.mtime) : meta.mtime;
        tree.files.set(path, { ...current, crdt: crdt || undefined, madeAt });
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

  /**
   * Remove pending folders that hold no files now. Asked for after each
   * deletion a peer sends, several of which are applied at once: one check
   * runs at a time, and the requests made meanwhile are one more check, so
   * that a folder is not deleted twice over.
   */
  private _prunePendingFolders(): Promise<void> {
    if (this.pruning) {
      this.pruneAgain = true;
      return this.pruning;
    }
    this.pruning = (async () => {
      do {
        this.pruneAgain = false;
        await this._prunePendingFoldersNow();
      } while (this.pruneAgain);
    })().finally(() => {
      this.pruning = null;
    });
    return this.pruning;
  }

  private pruning: Promise<void> | null = null;
  private pruneAgain = false;

  private async _prunePendingFoldersNow(): Promise<void> {
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

  /**
   * Record the notes a peer's file list shows with the same content as
   * ours: that content is what this device and that peer last had in common
   * (see FileMeta.agreed). Only from file lists, so it is never recorded for
   * content the peer did not actually have; a note that merely reached the
   * peer from us is recorded at the next exchange. Also learns, for those
   * notes, an earlier time the peer gives for the same version (see
   * FileMeta.madeAt). Notes gone from here, or from the peer's list, are
   * forgotten.
   */
  private _noteAgreedHashes(deviceId: string, localFiles: Map<string, FileMeta>, remoteFiles: Map<string, FileMeta>): void {
    let agreed = this.agreedHashes.get(deviceId);
    if (!agreed) {
      agreed = new Map();
      this.agreedHashes.set(deviceId, agreed);
    }
    for (const [path, remote] of remoteFiles) {
      const local = localFiles.get(path);
      if (!local?.isTextFile || !remote.isTextFile || local.hash !== remote.hash) continue;
      const madeAt = local.madeAt ?? local.mtime;
      if (SyncCoordinator._isTime(remote.madeAt) && remote.madeAt < madeAt) {
        this.versionTimes.set(path, { hash: local.hash, at: remote.madeAt });
        this.agreedHashesChanged = true;
      }
      if (agreed.get(path) === local.hash) continue;
      agreed.set(path, local.hash);
      this.agreedHashesChanged = true;
    }
    // A note the peer no longer lists has no version it would name for it.
    for (const path of agreed.keys()) {
      if (remoteFiles.has(path)) continue;
      agreed.delete(path);
      this.agreedHashesChanged = true;
    }
    for (const records of this.agreedHashes.values()) {
      for (const path of records.keys()) {
        if (localFiles.has(path)) continue;
        records.delete(path);
        this.agreedHashesChanged = true;
      }
    }
    for (const path of this.versionTimes.keys()) {
      if (localFiles.has(path)) continue;
      this.versionTimes.delete(path);
      this.agreedHashesChanged = true;
    }
    // Only a day's precision is needed (see _forgetOldAgreedPeers); a save
    // at every exchange would not be.
    const now = Date.now();
    if (now - (this.agreedPeersSeen.get(deviceId) ?? 0) > SyncCoordinator.DAY_MS) {
      this.agreedPeersSeen.set(deviceId, now);
      this.agreedHashesChanged = true;
    }
    this._forgetOldAgreedPeers();
    // Saved right away: the app may be closed without notice before the
    // next save, and a version recorded later is lost with it.
    if (this.agreedHashesChanged) void this._saveAgreedHashes();
  }

  private static readonly DAY_MS = 24 * 60 * 60 * 1000;
  /** Peers whose file list has not come for this long are forgotten (a reinstall gets a new device ID). */
  private static readonly AGREED_PEER_TTL_MS = 90 * SyncCoordinator.DAY_MS;
  /** At most this many peers are remembered, the most recently seen ones. */
  private static readonly MAX_AGREED_PEERS = 32;

  /**
   * Forget the versions shared with peers not seen for long. Such a peer
   * coming back settles notes changed on both sides by time again, keeping
   * a conflict copy, as before these records existed.
   */
  private _forgetOldAgreedPeers(): void {
    const now = Date.now();
    const bySeen = [...this.agreedHashes.keys()].sort(
      (a, b) => (this.agreedPeersSeen.get(b) ?? 0) - (this.agreedPeersSeen.get(a) ?? 0),
    );
    bySeen.forEach((peer, i) => {
      if (i < SyncCoordinator.MAX_AGREED_PEERS && now - (this.agreedPeersSeen.get(peer) ?? 0) <= SyncCoordinator.AGREED_PEER_TTL_MS) return;
      this.agreedHashes.delete(peer);
      this.agreedPeersSeen.delete(peer);
      this.agreedHashesChanged = true;
    });
  }

  /** A time in a peer's file list that can be compared with ours. */
  private static _isTime(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }

  /**
   * Read the records saved by _saveAgreedHashes. A file in the earlier form
   * (one hash per note, {path: hash}, from test builds) is ignored: it does
   * not say which peer a version was shared with, which is the very thing
   * that was wrong with it. The records are made again at the next file
   * list exchange with each peer.
   */
  private async _loadAgreedHashes(): Promise<void> {
    const adapter = (this.vault as any).adapter;
    try {
      if (!adapter || !(await adapter.exists(AGREED_HASHES_FILE))) return;
      const saved = JSON.parse(await adapter.read(AGREED_HASHES_FILE)) as Partial<SavedAgreedHashes>;
      if (saved?.version !== 2 || !Array.isArray(saved.peers)) return;
      const peers: Array<Map<string, string> | null> = saved.peers.map((p) => {
        if (!p || typeof p.id !== "string" || !SyncCoordinator._isTime(p.seen)) return null;
        const records = new Map<string, string>();
        this.agreedHashes.set(p.id, records);
        this.agreedPeersSeen.set(p.id, p.seen);
        return records;
      });
      for (const [path, hashes] of Object.entries(saved.files ?? {})) {
        peers.forEach((records, i) => {
          const hash = typeof hashes === "string" ? hashes : Array.isArray(hashes) ? hashes[i] : null;
          if (records && typeof hash === "string") records.set(path, hash);
        });
      }
      for (const [path, time] of Object.entries(saved.times ?? {})) {
        if (Array.isArray(time) && typeof time[0] === "string" && SyncCoordinator._isTime(time[1])) {
          this.versionTimes.set(path, { hash: time[0], at: time[1] });
        }
      }
      this._forgetOldAgreedPeers();
    } catch (err) {
      logger.warn("Could not read the versions last shared with peers:", err);
    }
  }

  /**
   * The records in the form saved: a note's hash is written once when every
   * peer has the same one (the usual case), so the file is no larger than
   * one record per note; otherwise one entry per peer, in the order of
   * `peers`, null where there is none.
   */
  private _agreedHashesToSave(): SavedAgreedHashes {
    const ids = [...this.agreedHashes.keys()];
    const files: SavedAgreedHashes["files"] = {};
    const paths = new Set<string>();
    for (const records of this.agreedHashes.values()) for (const path of records.keys()) paths.add(path);
    for (const path of paths) {
      const hashes = ids.map((id) => this.agreedHashes.get(id)!.get(path) ?? null);
      files[path] = hashes.every((h) => h !== null && h === hashes[0]) ? hashes[0]! : hashes;
    }
    const times: SavedAgreedHashes["times"] = {};
    for (const [path, { hash, at }] of this.versionTimes) times[path] = [hash, at];
    return {
      version: 2,
      peers: ids.map((id) => ({ id, seen: this.agreedPeersSeen.get(id) ?? Date.now() })),
      files,
      times,
    };
  }

  /** Saves run one after another, so an older list never overwrites a newer one. */
  private _saveAgreedHashes(): Promise<void> {
    this.agreedHashesSave = this.agreedHashesSave.then(async () => {
      const adapter = (this.vault as any).adapter;
      if (!adapter || !this.agreedHashesChanged) return;
      this.agreedHashesChanged = false;
      try {
        await ensureParentDirectory(adapter, AGREED_HASHES_FILE);
        await adapter.write(AGREED_HASHES_FILE, JSON.stringify(this._agreedHashesToSave()));
      } catch (err) {
        this.agreedHashesChanged = true;
        logger.warn("Could not save the versions last shared with peers:", err);
      }
    });
    return this.agreedHashesSave;
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

  /**
   * Our file list for one peer. Each peer is told the versions we last had
   * in common with it (FileMeta.agreed), so a list made once is encoded for
   * each peer it goes to.
   */
  private _encodeTree(fileList: FileMeta[], deviceId: string, isResponse?: boolean): Uint8Array {
    const agreed = this.agreedHashes.get(deviceId);
    const files = agreed?.size
      ? fileList.map((f) => {
          const hash = f.isTextFile ? agreed.get(f.path) : undefined;
          return hash ? { ...f, agreed: hash } : f;
        })
      : fileList;
    const deleted = this.tombstones.list().filter((t) => !this.filter.shouldIgnore(t.path));
    // Deletions not yet recorded go too, as they will be recorded: the peer
    // would otherwise take the files for ones we lack and send them back.
    if (this.pendingLocalDeletes.size > 0) {
      const byPath = new Map(deleted.map((t, i) => [t.path, i]));
      for (const { record } of this.pendingLocalDeletes.values()) {
        if (!this._localDeletePending(record.path)) continue;
        const at = byPath.get(record.path);
        if (at === undefined) deleted.push(record);
        else if (deleted[at].deletedAt < record.deletedAt) deleted[at] = record;
      }
    }
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
    for (const ours of this.tombstones.renamesTo(path)) {
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
    const existing = this._caseVariantFile(path);
    if (!existing) return false;
    this._reportUnsyncable(path, this._caseClashReason(existing));
    // The peer's text for it, if that is what came: kept, it would make the
    // note's next fetch, once the name is free, bring nothing new to write.
    await this.docManager.removeDoc(path);
    return true;
  }

  /**
   * A file whose path differs from `path` only in case, if there is one.
   * Looked up through the folders on the way, comparing names without case:
   * this runs for every file a peer creates here, and going through all the
   * vault's files each time made a bulk create take quadratic time.
   */
  private _caseVariantFile(path: string): string | null {
    const lower = path.toLowerCase();
    const root = (this.vault as any).getRoot?.() as TFolder | undefined;
    if (!(root instanceof TFolder)) {
      return this.vault.getFiles().find((f) => f.path !== path && f.path.toLowerCase() === lower)?.path ?? null;
    }
    const names = lower.split("/");
    let level: TAbstractFile[] = [root];
    for (let i = 0; i < names.length && level.length > 0; i++) {
      const next: TAbstractFile[] = [];
      for (const folder of level) {
        if (!(folder instanceof TFolder)) continue;
        for (const child of folder.children) {
          const name = child.path.slice(child.path.lastIndexOf("/") + 1);
          if (name.toLowerCase() === names[i]) next.push(child);
        }
      }
      level = next;
    }
    return level.find((f) => f instanceof TFile && f.path !== path)?.path ?? null;
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
    apart?: { ours: ApartText; theirs: ApartText },
  ): Promise<void> {
    if (await this._applyToRenamed(deviceId, filePath, update)) return;
    await this._flushPendingLocalTextChange(filePath);
    if (!this._hasConflictLoserGuard(filePath)) {
      await this._ensureCrdtInitialized(filePath);
    }
    const related = apart
      ? await this.docManager.applyRelatedUpdate(filePath, update, deviceId, this._settleApartEdits(deviceId, filePath, apart))
      : await this.docManager.applyRelatedUpdate(filePath, update, deviceId);
    if (!related) {
      // A separate history of the note: keep one of the two, never both.
      await this._applyFullState(deviceId, filePath, update);
    }
  }

  /**
   * Apply a peer's whole doc; see YjsDocManager.applyFullState. `theirsAdopted`:
   * the peer marked it as a history it adopted a moment ago (see
   * recentAdoptions).
   */
  private async _applyFullState(
    deviceId: string,
    filePath: string,
    update: Uint8Array,
    theirsAdopted?: AdoptedHistory,
  ): Promise<void> {
    // One at a time per note: whether we adopted is part of the decision,
    // so a doc from another peer must not be weighed while an adoption is
    // still being written.
    const previous = this.fullStateQueues.get(filePath) ?? Promise.resolve();
    const run = previous.then(() => this._applyFullStateNow(deviceId, filePath, update, theirsAdopted));
    const tail = run.catch(() => undefined);
    this.fullStateQueues.set(filePath, tail);
    try {
      await run;
    } finally {
      if (this.fullStateQueues.get(filePath) === tail) this.fullStateQueues.delete(filePath);
    }
  }

  private async _applyFullStateNow(
    deviceId: string,
    filePath: string,
    update: Uint8Array,
    theirsAdopted: AdoptedHistory | undefined,
  ): Promise<void> {
    const file = this.vault.getAbstractFileByPath(filePath);
    const before = file instanceof TFile ? await this.vault.read(file) : "";
    let decision =
      this.historyWinners.get(this._peerPathKey(deviceId, filePath)) ??
      (await this._decideWithoutFileLists(deviceId, filePath, update, before));
    if (decision?.localWins === undefined) {
      // Undecided, the two histories were settled by their random client
      // IDs. When one side has just adopted its history from a third
      // device, that history won a decision there, and the other side's
      // is the one it dropped: a device that passed on an adopted history
      // to peers that still held the old one took the old one back from
      // the first of them to answer (and kept the newer version as a
      // copy), then switched again at the next file list exchange. Both
      // sides tell the same: each knows whether it adopted, and is told
      // whether the other did. When both did (opposite histories at the
      // same time), it is left to the client IDs as before.
      const oursAdopted = !!this._adoptedRecently(filePath);
      if (oursAdopted && !theirsAdopted) {
        decision = { localWins: true, keepCopy: decision?.keepCopy ?? true };
      } else if (theirsAdopted && !oursAdopted) {
        // Our text is the one the peer dropped: it was weighed there, and
        // kept as a copy there if it was to be, which reaches us like any
        // note. Another text of ours was not, and is kept.
        const weighed = theirsAdopted.dropped === (await this._hashText(before));
        decision = { localWins: false, keepCopy: decision?.keepCopy ?? !weighed };
      }
    }
    const result = await this.docManager.applyFullState(filePath, update, deviceId, decision?.localWins);
    if (result === "kept-local") {
      // Our doc wins; send it so the peer adopts it. Not again right away
      // for the same two docs: the peer has ours, and sends its own back
      // only when it decided otherwise, which another send would not
      // change. Such a pair (one side holding a decision from a file list
      // the other has since replaced) traded the two docs thousands of
      // times a second; the next file list exchange settles it.
      const key = this._peerPathKey(deviceId, filePath);
      const pair = `${svKey(await this.docManager.encodeSyncStep1(filePath))}|${svKey(Y.encodeStateVectorFromUpdate(update))}`;
      const sent = this.resolvingSent.get(key);
      if (sent?.pair === pair && Date.now() - sent.at < SyncCoordinator.RESOLVE_RESEND_MS) return;
      this.resolvingSent.set(key, { pair, at: Date.now() });
      await this._sendFullTextState(deviceId, filePath, "Resolving unrelated history");
    } else if (result === "adopted") {
      // The note we had came from another history and is now replaced.
      // Only a different text is a decision to pass on as such: the same
      // text under another history (two devices that each started the
      // note's history on their own) is not.
      if (before !== (await this.docManager.getContent(filePath))) {
        this.recentAdoptions.set(filePath, { at: Date.now(), dropped: await this._hashText(before) });
        if (decision?.keepCopy !== false) await this._createConflictCopy(filePath, before);
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
   * Settle a peer's changes to a note that both devices changed while apart
   * (see apartTexts), once they are merged into ours. Changes to different
   * lines merge as usual. Changes to the same line merge, character by
   * character, into a line neither device wrote: then the note is to hold
   * one device's whole version, the one modified later (as for notes with
   * separate histories, see _decideConflict), and the other version is kept
   * as a conflict copy.
   *
   * Both devices decide this from the same texts: the merged note, and the
   * two texts they sent each other when they connected. Only the device
   * whose version lost acts: it keeps its own version (only it has that
   * text) and puts the other one back (it was sent that text), and peers
   * get both as usual. Were the winner to put its version back on its own,
   * a loser that had decided otherwise would make no copy, and its version
   * would be lost; this way a differing decision leaves the merged note.
   */
  private _settleApartEdits(
    deviceId: string,
    filePath: string,
    apart: { ours: ApartText; theirs: ApartText },
  ): (before: string, merged: string) => Promise<string | null> {
    return async (before, merged) => {
      // Our text as we sent it, and as it is now: a line typed since then
      // is not a merge of both versions.
      if (!hasLineFromNeither(merged, [apart.ours.text, before, apart.theirs.text])) return null;
      if (this._isConflictWinner(apart.ours.mtime, apart.theirs.mtime, deviceId)) {
        this._emitEvent(`Same lines edited apart, keeping this version: ${filePath}`);
        return null;
      }
      // Ours before the merge holds anything typed since we sent it. Not
      // kept, it must stay in the note.
      if (!(await this._createConflictCopy(filePath, before))) return null;
      this._emitEvent(`Same lines edited apart, keeping ${deviceId}'s version: ${filePath}`);
      return apart.theirs.text;
    };
  }

  /** How long texts sent at connect wait for the peer's changes. */
  private static readonly APART_TEXT_TTL_MS = 10 * 60 * 1000;

  private _noteApartText(deviceId: string, path: string, text: { ours?: ApartText; theirs?: ApartText }): void {
    const key = this._peerPathKey(deviceId, path);
    this.apartTexts.set(key, { ...this.apartTexts.get(key), ...text, at: Date.now() });
  }

  /**
   * Both texts exchanged for a note at connect, if both were, taken so they
   * are used for the peer's first answer only: later changes are made while
   * connected, and texts from then would no longer describe them.
   */
  private _takeApartTexts(deviceId: string, path: string): { ours: ApartText; theirs: ApartText } | undefined {
    const key = this._peerPathKey(deviceId, path);
    const texts = this.apartTexts.get(key);
    this.apartTexts.delete(key);
    if (!texts?.ours || !texts.theirs) return undefined;
    if (Date.now() - texts.at > SyncCoordinator.APART_TEXT_TTL_MS) return undefined;
    return { ours: texts.ours, theirs: texts.theirs };
  }

  private _forgetApartTexts(deviceId: string): void {
    const prefix = `${deviceId}\n`;
    for (const key of this.apartTexts.keys()) {
      if (key.startsWith(prefix)) this.apartTexts.delete(key);
    }
  }

  /**
   * Keep a version of a note that lost a conflict as "name (conflict 1a2b3c).ext".
   * The suffix comes from the content, so devices that keep the same version
   * create the same file instead of one copy each. Returns whether the
   * version is kept (an empty one needs no copy).
   */
  private async _createConflictCopy(filePath: string, content: string): Promise<boolean> {
    if (!content) return true;
    const slash = filePath.lastIndexOf("/");
    const dot = filePath.lastIndexOf(".");
    const extAt = dot > slash ? dot : filePath.length;
    const hash = await computeFileHash(new TextEncoder().encode(content).buffer as ArrayBuffer);
    const copyPath = `${filePath.slice(0, extAt)} (conflict ${hash.slice(0, 6)})${filePath.slice(extAt)}`;
    if (this.vault.getAbstractFileByPath(copyPath)) return true;
    try {
      await this.vault.create(copyPath, content);
      this._emitEvent(`Kept the other version as ${copyPath}`);
      return true;
    } catch (err) {
      logger.warn(`Could not create conflict copy for ${filePath}:`, err);
      return false;
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
    // Both devices last had the same version in common, and one of them
    // still has it: the note was changed on the other side only, so that
    // side wins whatever the times say, and the old version is not kept
    // again as a copy. This is the case of a device that lost the notes'
    // sync history. The versions are the ones shared with each other (see
    // agreedHashes), and only when both name the same one: a device that
    // names none (it lost everything, or runs an older version) cannot tell.
    const agreed = this._agreedWith(deviceId, local.path);
    if (agreed && agreed === remote.agreed) {
      if (remote.hash === agreed) return { localWins: true, keepCopy: false };
      if (local.hash === agreed) return { localWins: false, keepCopy: false };
    }
    // Changed on both sides: the version made later wins. When both lists
    // say when each version was made (FileMeta.madeAt), that is used: it is
    // the same on every device that has the version, so every device that
    // meets the other version decides alike. A device's modified time of a
    // version it received is when it wrote it, by its own clock, and
    // differs from device to device: one peer that wrote the earlier
    // version late won while another lost, and both versions were kept as
    // copies with the earlier one ending up in the note. A peer that does
    // not send it (an older version) decides by modified times, so then do we.
    const made = SyncCoordinator._isTime(local.madeAt) && SyncCoordinator._isTime(remote.madeAt);
    return {
      localWins: this._isConflictWinner(made ? local.madeAt! : local.mtime, made ? remote.madeAt! : remote.mtime, deviceId),
      keepCopy: true,
    };
  }

  /** The version of a note this device last had in common with a peer; see agreedHashes. */
  private _agreedWith(deviceId: string, path: string): string | undefined {
    return this.agreedHashes.get(deviceId)?.get(path);
  }

  private _peerPathKey(deviceId: string, path: string): string {
    return `${deviceId}\n${path}`;
  }

  private _forgetHistoryWinners(deviceId: string): void {
    const prefix = `${deviceId}\n`;
    for (const key of this.historyWinners.keys()) {
      if (key.startsWith(prefix)) this.historyWinners.delete(key);
    }
    for (const key of this.peerAgreedHashes.keys()) {
      if (key.startsWith(prefix)) this.peerAgreedHashes.delete(key);
    }
    for (const key of this.resolvingSent.keys()) {
      if (key.startsWith(prefix)) this.resolvingSent.delete(key);
    }
  }

  /**
   * Which history to keep when a peer's whole doc of a note arrives with no
   * decision from the file lists: the two copies were the same then (a
   * history shared at connect, or one a peer adopted from a third device
   * and passes on). The incoming text tells:
   * - the same text as ours: whichever history is kept, nothing of ours is
   *   lost, so no conflict copy (left to the histories, as before). Other
   *   peers' edits merged in right after the switch used to make the note
   *   differ from what we had, which left a copy of a version every device
   *   still had;
   * - otherwise decided like _decideConflict, from the version both last had
   *   in common (FileMeta.agreed), with the incoming text in place of the
   *   peer's file. Nothing is decided (as before) when that does not tell.
   */
  private async _decideWithoutFileLists(
    deviceId: string,
    filePath: string,
    update: Uint8Array,
    localText: string,
  ): Promise<{ localWins?: boolean; keepCopy: boolean } | undefined> {
    const incoming = new Y.Doc();
    let theirs: string;
    try {
      Y.applyUpdate(incoming, update);
      theirs = incoming.getText("content").toString();
    } catch {
      return undefined;
    } finally {
      incoming.destroy();
    }
    if (theirs === localText) return { keepCopy: false };
    // The version we last had in common with this peer, as both of us name it.
    const agreed = this._agreedWith(deviceId, filePath);
    if (!agreed || this.peerAgreedHashes.get(this._peerPathKey(deviceId, filePath)) !== agreed) return undefined;
    if ((await this._hashText(theirs)) === agreed) return { localWins: true, keepCopy: false };
    if ((await this._hashText(localText)) === agreed) return { localWins: false, keepCopy: false };
    return undefined;
  }

  /** How soon our doc is sent back again for the same two docs; see _applyFullState. */
  private static readonly RESOLVE_RESEND_MS = 10 * 1000;

  /** How long an adopted history is passed on marked as such; see recentAdoptions. */
  private static readonly ADOPTED_HISTORY_TTL_MS = 60 * 1000;

  private _adoptedRecently(path: string): AdoptedHistory | undefined {
    const adoption = this.recentAdoptions.get(path);
    if (!adoption) return undefined;
    if (Date.now() - adoption.at <= SyncCoordinator.ADOPTED_HISTORY_TTL_MS) return { dropped: adoption.dropped };
    this.recentAdoptions.delete(path);
    return undefined;
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

/** A state vector as a string, to compare. */
function svKey(stateVector: Uint8Array): string {
  return Array.from(stateVector).join(",");
}
