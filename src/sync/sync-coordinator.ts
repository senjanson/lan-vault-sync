import { Vault, TFile, Workspace } from "obsidian";
import * as Y from "yjs";
import { ConnectionManager } from "../transport/connection-manager";
import {
  encodeYjsSync,
  decodeYjsSync,
  encodeFileMetaSync,
  decodeJSON,
} from "../transport/protocol";
import { YjsDocManager } from "../crdt/yjs-doc-manager";
import { ConflictBackupService } from "../conflict/conflict-backup-service";
import { BinaryFileSyncService } from "../binary-sync/binary-sync-service";
import { VaultWatcher } from "../watcher/vault-watcher";
import { DiscoveryService } from "../discovery/discovery-service";
import { FileFilter } from "../watcher/file-filter";
import { SyncStateMachine } from "./sync-state";
import { buildFileTree, diffFileTrees } from "./file-tree";
import { SyncLogService } from "../sync-log/sync-log-service";
import {
  DeviceInfo,
  FileChangeEvent,
  FileMetaSyncPayload,
  LANSyncSettings,
  MessageType,
  SyncState,
} from "../types";
import { logger } from "../logger";
import { ensureParentDirectory, isSafeSyncPath } from "../utils/path-utils";
import { supportsIncomingConnections } from "../utils/runtime";
import { parsePeerAddress } from "../discovery/manual-peers";

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
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private pendingInitialBootstrapPeers = new Set<string>();
  /** Tracks (deviceId:filePath) combos where we've already sent a reverse
   *  SYNC_STEP1 in response to receiving one, to prevent infinite loops. */
  private reverseSyncSent = new Set<string>();
  /** Tracks file paths where we are the conflict "loser" and must NOT seed
   *  the CRDT doc from disk.  Stored per winning peer so an unrelated
   *  disconnect does not clear protection for active conflicts on other peers.
   *  The winner will send us their content via YJS_UPDATE on an empty doc —
   *  initialising it from disk would cause duplication when the update is
   *  applied. */
  private conflictLoserPaths = new Map<string, Set<string>>();
  private localFileChangeQueue: Promise<void> = Promise.resolve();
  private recentRemoteTextRenames = new Map<
    string,
    { newPath: string; expiresAt: number }
  >();
  /** Text we last wrote to disk for a remote change, to recognise its echo. */
  private remoteWrittenText = new Map<string, string>();
  private vaultId: string;
  private syncLogService: SyncLogService | null;

  private onStateChangeCb: ((state: SyncState) => void) | null = null;
  private onSyncEventCb: ((msg: string) => void) | null = null;

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
    this.backupService =
      options?.backupService ?? new ConflictBackupService(vault);
    this.syncLogService = options?.syncLogService ?? null;
    this.binarySync = new BinaryFileSyncService(
      vault,
      this.connectionManager,
      this.backupService,
      (path) => this._isAllowedPath(path),
    );
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
      this.stateMachine.transition("discovering");

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

      this.stateMachine.transition("watching");
      this._emitEvent("Sync service started");
    } catch (err) {
      logger.error("Failed to start sync:", err);
      this.stateMachine.transition("error");
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
    await this.syncLogService?.flush();

    this.stateMachine.transition("idle");
    this._emitEvent("Sync service stopped");
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
    this.connectionManager.onPeerConnected(async (device) => {
      this._emitEvent(`Connected to ${device.deviceId}`);
      this.pendingInitialBootstrapPeers.add(device.deviceId);
      await this._initialSyncWith(device.deviceId);
    });

    this.connectionManager.onPeerDisconnected((deviceId) => {
      this.pendingInitialBootstrapPeers.delete(deviceId);
      this.binarySync.dropIncoming(deviceId);
      // Clear reverse-sync tracking for this peer
      for (const key of this.reverseSyncSent) {
        if (key.startsWith(deviceId + ":")) this.reverseSyncSent.delete(key);
      }
      // Clear only guards associated with the disconnected peer — unrelated
      // peers may still be mid-conflict on their own paths.
      this._clearConflictLoserGuardsForDevice(deviceId);
      this._emitEvent(`Disconnected: ${deviceId}`);
    });

    // Incoming protocol messages
    this.connectionManager.onMessage(async (deviceId, type, payload) => {
      await this._handleMessage(deviceId, type, payload);
    });

    // Vault watcher → local changes
    this.watcher.onFileChanged((event) => {
      void this._enqueueLocalFileChange(event);
    });

    // Yjs doc manager → broadcast local updates
    this.docManager.onLocalUpdate((filePath, update) => {
      const msg = encodeYjsSync(MessageType.YJS_UPDATE, filePath, update);
      this.connectionManager.broadcast(msg);
    });

    // Yjs doc manager → remote content changed, write to file
    this.docManager.onRemoteContent(
      async (filePath, content, previousContent) => {
        await this._writeFileFromRemote(filePath, content, previousContent);
      },
    );

    // Binary sync → mark remote writes
    this.binarySync.onRemoteFileWritten((path) => {
      this.watcher.markRemoteWrite(path);
    });

    this.binarySync.onRemoteFileDeleted(async (path) => {
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
        const resolvedPath = this._resolveRecentRemoteTextRename(msg.filePath);
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

        // Complete bidirectional sync: also send our own state vector so the
        // initiator can send back the diff we're missing.  Guard with a
        // per-(peer,file) flag to prevent infinite SYNC_STEP1 ping-pong.
        const reverseKey = `${deviceId}:${resolvedPath}`;
        if (!this.reverseSyncSent.has(reverseKey)) {
          this.reverseSyncSent.add(reverseKey);
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
        const resolvedPath = this._resolveRecentRemoteTextRename(msg.filePath);
        await this._flushPendingLocalTextChange(resolvedPath);
        await this.docManager.handleSyncStep2(resolvedPath, msg.data);
        // Clear reverse-sync guard so future sync rounds can proceed
        this.reverseSyncSent.delete(`${deviceId}:${resolvedPath}`);
        break;
      }

      case MessageType.YJS_FULL_STATE: {
        const msg = decodeYjsSync(payload);
        if (!this._isAllowedPath(msg.filePath)) break;
        const resolvedPath = this._resolveRecentRemoteTextRename(msg.filePath);
        await this._flushPendingLocalTextChange(resolvedPath);
        const result = await this.docManager.applyFullState(resolvedPath, msg.data);
        if (result === "kept-local") {
          // Our doc wins; send it so the peer adopts it.
          await this._sendFullTextState(deviceId, resolvedPath, "Resolving unrelated history");
        } else if (result === "adopted") {
          // Other peers may still hold the history we just dropped.
          for (const peerId of this.connectionManager.getConnectedPeerIds()) {
            if (peerId !== deviceId) {
              await this._sendFullTextState(peerId, resolvedPath, "Sharing adopted history");
            }
          }
        }
        break;
      }

      case MessageType.YJS_UPDATE: {
        const msg = decodeYjsSync(payload);
        if (!this._isAllowedPath(msg.filePath)) break;
        const resolvedPath = this._resolveRecentRemoteTextRename(msg.filePath);
        await this._flushPendingLocalTextChange(resolvedPath);
        await this.docManager.applyRemoteUpdate(resolvedPath, msg.data);
        break;
      }

      case MessageType.FILE_META_SYNC: {
        const meta = decodeJSON<FileMetaSyncPayload>(payload);
        await this._handleRemoteFileTree(deviceId, meta);

        // If this is NOT a response, send our file tree back so the peer also
        // processes our files.  This ensures bidirectional tree exchange even
        // during one-sided periodic syncs.
        if (!meta.isResponse) {
          const tree = await buildFileTree(this.vault, this.filter);
          const metaList = Array.from(tree.files.values());
          const reply = encodeFileMetaSync({
            files: metaList,
            isResponse: true,
          });
          this.connectionManager.sendTo(deviceId, reply);
        }
        break;
      }

      case MessageType.FILE_REQUEST:
      case MessageType.FILE_DATA:
      case MessageType.FILE_DELETE:
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
          await this.docManager.applyLocalChange(path, content);
        } else {
          await this.binarySync.broadcastFileChange(path);
        }
        this.syncLogService?.addEntry("local-send", path, {
          hasSnapshot: false,
          details: { isText: isTextFile },
        });
        break;
      }

      case "delete": {
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

  private async _writeFileFromRemote(
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
        this._clearConflictLoserGuard(filePath);
        return;
      }

      this.watcher.markRemoteWrite(filePath);
      this.remoteWrittenText.set(filePath, latestContent);

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
      const tree = await buildFileTree(this.vault, this.filter);
      const metaList = Array.from(tree.files.values());
      const msg = encodeFileMetaSync({ files: metaList });
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
    const localTree = await buildFileTree(this.vault, this.filter);
    const isInitialBootstrap = this.pendingInitialBootstrapPeers.has(deviceId);
    const remoteFiles = new Map<string, (typeof meta.files)[number]>();
    for (const f of meta.files) {
      // Never pull files this device ignores (or cannot safely write).
      if (!this._isAllowedPath(f.path)) continue;
      remoteFiles.set(f.path, f);
    }

    const treeDiff = diffFileTrees(localTree.files, remoteFiles);

    // Files only on remote — request them via CRDT sync or binary transfer
    for (const file of treeDiff.remoteOnly) {
      if (file.isTextFile) {
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

    if (isInitialBootstrap) {
      for (const [path, local] of localTree.files) {
        const remote = remoteFiles.get(path);
        if (!remote || !local.isTextFile) continue;
        if (local.hash !== remote.hash) continue;
        if (!this._shouldBootstrapSharedTextState(deviceId)) continue;

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
    if (this.docManager.isDocActive(filePath)) return;
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
    const tree = await buildFileTree(this.vault, this.filter);
    const metaList = Array.from(tree.files.values());
    onProgress(
      15,
      `Found ${metaList.length} files, syncing with ${peers.length} peer(s)...`,
    );

    const totalPeers = peers.length;
    for (let i = 0; i < peers.length; i++) {
      const peerId = peers[i];
      const peerPercent = 20 + ((i + 1) / totalPeers) * 50;

      const msg = encodeFileMetaSync({ files: metaList });
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
    if (written === content) return true;
    this.remoteWrittenText.delete(path);
    return false;
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
