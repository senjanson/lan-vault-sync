import { Notice, Platform, Plugin, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { LANSyncSettings, DEFAULT_SETTINGS } from "./types";
import {
  PLUGIN_ID,
  SYNC_VIEW_TYPE,
  SYNC_LOG_VIEW_TYPE,
  WS_PORT_MIN,
  WS_PORT_MAX,
  FILE_INDEX_FILE,
  setConfigDir,
} from "./constants";
import { copyLegacyState } from "./utils/legacy-state";
import { setDebugEnabled, setLogSink } from "./logger";
import { parsePeerAddress } from "./discovery/manual-peers";
import { SyncCoordinator } from "./sync/sync-coordinator";
import { generateSyncKey, normalizeSyncKey } from "./transport/auth";
import type { AuthFailure } from "./transport/connection-manager";
import { confirmDialog } from "./ui/confirm-modal";
import { textInputDialog } from "./ui/text-input-modal";
import { ConflictBackupService } from "./conflict/conflict-backup-service";
import { SyncLogService } from "./sync-log/sync-log-service";
import { StatusBar } from "./ui/status-bar";
import { LANSyncSettingTab } from "./ui/settings-tab";
import { SyncView } from "./ui/sync-view";
import type { SyncViewStatus } from "./ui/sync-view";
import { SyncLogView } from "./ui/sync-log-view";
import { canUseNodeRuntime } from "./utils/runtime";
import { t } from "./i18n";
import { openRecoveryCenter, registerRecoveryCenter } from "./history/recovery-view";
import { EventLog } from "./diagnostics/event-log";
import { buildDiagnostics, diagnosticsFileName, DIAGNOSTICS_DIR } from "./diagnostics/export";
import { alertText } from "./diagnostics/health";
import { ensureDirectory } from "./utils/path-utils";
import { effectiveVaultId, isValidVaultId } from "./utils/vault-id";

function generateDeviceId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function generateRandomPort(): number {
  // Random port in the IANA dynamic/private range to avoid same-machine vault conflicts.
  return (
    Math.floor(Math.random() * (WS_PORT_MAX - WS_PORT_MIN + 1)) + WS_PORT_MIN
  );
}

/** How long the notice of another device with this device's ID stays up. */
const DUPLICATE_NOTICE_MS = 60_000;

export default class LANSyncPlugin extends Plugin {
  settings: LANSyncSettings = DEFAULT_SETTINGS;
  private coordinator: SyncCoordinator | null = null;
  private statusBar: StatusBar | null = null;
  private backupService: ConflictBackupService | null = null;
  syncLogService: SyncLogService | null = null;
  /**
   * Last notice time per refused device and reason, so retries don't spam
   * notices. By device rather than address: the two connections between
   * two devices (one each way) come from different addresses.
   */
  private authNoticeAt = new Map<string, number>();
  /** Tells an open recovery center that the version store came or went. */
  private recoveryCenter: { storeChanged(): void } | null = null;
  /** Addresses the user was told cannot be reached, until they connect. */
  private unreachableNotified = new Set<string>();
  private startTimer: number | null = null;
  private restartTimer: number | null = null;
  private unloaded = false;

  async onload(): Promise<void> {
    // Sync state lives in the plugin's folder of the vault's config folder.
    setConfigDir(this.app.vault.configDir);
    await copyLegacyState(this.app.vault.adapter);
    await this.loadSettings();

    // Ensure device has a unique ID
    if (!this.settings.deviceId) {
      this.settings.deviceId = generateDeviceId();
      await this.saveSettings();
    }

    // Default device name
    if (!this.settings.deviceName) {
      this.settings.deviceName = `Device-${this.settings.deviceId.slice(0, 6)}`;
      await this.saveSettings();
    }

    // Only devices that share this key can connect. Every install gets its
    // own random key; pairing copies it to the other devices.
    if (!this.settings.syncKey) {
      this.settings.syncKey = generateSyncKey();
      await this.saveSettings();
    }

    // Assign a random port on first install so multiple vaults on the same machine don't collide
    if (!this.settings.port) {
      this.settings.port = generateRandomPort();
      await this.saveSettings();
    }

    setDebugEnabled(this.settings.enableDebugLog);

    // Initialize services
    this.backupService = new ConflictBackupService(this.app.vault);
    this.syncLogService = new SyncLogService(
      this.app.vault,
      this.settings,
      this.backupService,
    );
    await this.syncLogService.loadFromDisk();

    // Register view
    this.registerView(SYNC_VIEW_TYPE, (leaf: WorkspaceLeaf) => {
      return new SyncView(leaf, () => this.getSyncStatus(), {
        resolveHeld: async (id, choice) => {
          return (await this.coordinator?.resolveHeldDeletions(id, choice)) ?? false;
        },
        dismissAlert: (key) => this.coordinator?.health.dismiss(key),
        exportDiagnostics: () => this.exportDiagnostics(),
      });
    });

    // Register sync log view
    // Recovery center: old versions kept before sync changed a file.
    this.recoveryCenter = registerRecoveryCenter(this, () => this.coordinator?.versionStore ?? null);

    // Alerts about a file's failed step go once the file is written, or gone
    // (see HealthMonitor.notePathGone).
    const vault = this.app.vault;
    this.registerEvent(vault.on("create", (file: TAbstractFile) => this.coordinator?.health.notePathWritten(file.path)));
    this.registerEvent(vault.on("modify", (file: TAbstractFile) => this.coordinator?.health.notePathWritten(file.path)));
    this.registerEvent(vault.on("delete", (file: TAbstractFile) => this.coordinator?.health.notePathGone(file.path)));
    this.registerEvent(
      vault.on("rename", (_file: TAbstractFile, oldPath: string) => this.coordinator?.health.notePathGone(oldPath)),
    );

    this.registerView(SYNC_LOG_VIEW_TYPE, (leaf: WorkspaceLeaf) => new SyncLogView(leaf, this.syncLogService!));

    // Status bar
    this.statusBar = new StatusBar(this);

    // Settings tab
    this.addSettingTab(new LANSyncSettingTab(this.app, this));

    // Commands
    this.addCommand({
      id: "toggle-sync",
      name: t("cmd.toggle"),
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        if (this.settings.enabled) {
          await this.startSync();
        } else {
          await this.stopSync();
        }
      },
    });

    this.addCommand({
      id: "open-sync-panel",
      name: t("cmd.openPanel"),
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "open-sync-log",
      name: t("cmd.openLog"),
      callback: () => this.activateSyncLogView(),
    });

    this.addCommand({
      id: "export-diagnostics",
      name: t("cmd.exportDiagnostics"),
      callback: () => void this.exportDiagnostics(),
    });

    this.addCommand({
      id: "add-device-by-address",
      name: t("cmd.addPeer"),
      callback: async () => {
        const input = await textInputDialog(
          this.app,
          t("pair.addTitle"),
          "192.168.1.20:53712",
          t("common.add"),
        );
        if (!input) return;
        if (await this.addManualPeer(input)) {
          new Notice(t("notice.peerAdded", { address: input }));
        } else {
          new Notice(t("notice.peerInvalid", { address: input }));
        }
      },
    });

    // Protocol handler: obsidian://lan-vault-sync?address=ip:port&key=...
    // Note: Obsidian overwrites params.action with the handler name ("lan-vault-sync"),
    // so we cannot use a custom action parameter — just check for address directly.
    this.registerObsidianProtocolHandler(PLUGIN_ID, async (params) => {
      await this.handleProtocolParams(params);
    });

    // A phone suspends the app in the background and its connections drop.
    // Reconnect as soon as it is back rather than waiting out the backoff.
    const reconnect = () => this.coordinator?.reconnectNow();
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") reconnect();
      // A phone may stop the app in the background without notice.
      else void this.coordinator?.persist();
    });
    this.registerDomEvent(window, "online", reconnect);
    // Obsidian waits for these before it closes; onunload is not waited for.
    this.registerEvent(
      this.app.workspace.on("quit", (tasks) => {
        tasks.add(async () => {
          await this.coordinator?.persist();
        });
      }),
    );

    // Auto-start if enabled
    if (this.settings.enabled) {
      // Delay to let Obsidian finish loading
      // Cleared on unload, so disabling the plugin right after enabling it
      // does not leave a sync server running.
      // Wait for the layout: until then Obsidian reports every existing file
      // as newly created, which would be taken for local changes.
      this.app.workspace.onLayoutReady(() => {
        if (this.unloaded) return;
        this.startTimer = window.setTimeout(() => {
          this.startTimer = null;
          void this.startSync();
        }, 2000);
      });
    }
  }

  onunload(): void {
    void this.shutdown();
  }

  /** What onunload does; Obsidian does not wait for it. */
  private async shutdown(): Promise<void> {
    this.unloaded = true;
    setLogSink(null);
    if (this.restartTimer) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.startTimer) {
      window.clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    await this.stopSync();
    await this.syncLogService?.flush();
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<LANSyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // A new install leaves out the config folder too, whatever it is named.
    if (!saved?.ignoredPaths) this.settings.ignoredPaths = [`${this.app.vault.configDir}/`, ...DEFAULT_SETTINGS.ignoredPaths];
    // Unused since 0.5: every conflict keeps both versions.
    delete (this.settings as unknown as Record<string, unknown>).conflictStrategy;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    setDebugEnabled(this.settings.enableDebugLog);
  }

  async addManualPeer(address: string): Promise<boolean> {
    const parsed = parsePeerAddress(address);
    if (!parsed) {
      return false;
    }
    const normalized = `${parsed.ip}:${parsed.port}`;

    if (!this.settings.manualPeers.includes(normalized)) {
      this.settings.manualPeers.push(normalized);
      await this.saveSettings();
    }

    try {
      this.coordinator?.addManualPeer(normalized);
      return true;
    } catch {
      return false;
    }
  }

  private async handleProtocolParams(
    params: Record<string, string>,
  ): Promise<void> {
    if (!params.address) return;
    const address = params.address.trim();
    if (!parsePeerAddress(address)) {
      new Notice(t("notice.peerAddFailed", { address }));
      return;
    }

    // Any web page or message can open an obsidian:// link, so nothing is
    // changed without the user's confirmation.
    const key = params.key ? params.key.trim() : "";
    // The vault the link's device syncs (plan 6.3); links from before 0.5
    // carry none.
    const vault = params.vault && isValidVaultId(params.vault.trim()) ? params.vault.trim() : "";
    const changesVault = !!vault && vault !== this.getVaultId();
    const changesKey =
      !!key && normalizeSyncKey(key) !== normalizeSyncKey(this.settings.syncKey);
    const lines = [t("pair.ask", { address })];
    if (changesKey) {
      lines.push(
        t("pair.keyChange"),
      );
    }
    lines.push(t("pair.onlyYours"));
    const ok = await confirmDialog(this.app, t("pair.title"), lines, t("pair.confirm"));
    if (!ok) return;

    if (changesVault) {
      this.settings.vaultId = vault;
      await this.saveSettings();
      if (!changesKey && this.coordinator) await this.startSync();
    }
    if (changesKey) {
      await this.setSyncKey(key);
    }
    const added = await this.addManualPeer(address);
    if (added) {
      new Notice(t("notice.peerAdded", { address }));
    } else {
      new Notice(t("notice.peerAddFailed", { address }));
    }
  }

  /** This vault's ID as peers know it (see utils/vault-id). */
  getVaultId(): string {
    return this.coordinator?.getVaultId() ?? effectiveVaultId(this.settings, this.app.vault.getName());
  }

  /**
   * A new device ID, for a device that shares its ID with another. The
   * record of files synced so far is cleared with it: it was made under the
   * old ID, and read under the new one it could take files for deleted.
   */
  async regenerateDeviceId(): Promise<void> {
    const running = !!this.coordinator;
    if (running) await this.stopSync();
    this.settings.deviceId = generateDeviceId();
    await this.saveSettings();
    const adapter = this.app.vault.adapter;
    for (const f of [FILE_INDEX_FILE, `${FILE_INDEX_FILE}.bak`, `${FILE_INDEX_FILE}.tmp`]) {
      if (await adapter.exists(f).catch(() => false)) await adapter.remove(f).catch(() => undefined);
    }
    new Notice(t("notice.idRegenerated", { id: this.settings.deviceId }));
    if (running) await this.startSync();
  }

  /** Change the pairing key and reconnect with it. */
  async setSyncKey(key: string): Promise<boolean> {
    const trimmed = key.trim();
    if (normalizeSyncKey(trimmed).length < 8) return false;
    if (trimmed === this.settings.syncKey) return true;
    this.settings.syncKey = trimmed;
    await this.saveSettings();
    if (this.coordinator) {
      await this.startSync();
    }
    return true;
  }

  private notifyAuthFailure(failure: AuthFailure): void {
    const now = Date.now();
    const key = `${failure.reason}\n${failure.deviceId || failure.deviceName || failure.address}`;
    const last = this.authNoticeAt.get(key) ?? 0;
    if (now - last < 10 * 60_000) return;
    this.authNoticeAt.set(key, now);
    const name = failure.deviceName || failure.address;
    new Notice(
      failure.reason === "outdated"
        ? t("notice.peerOutdated", { name })
        : failure.reason === "newer"
          ? t("notice.peerNewer", { name })
          : failure.reason === "vault-mismatch"
            ? t("notice.peerOtherVault", { name })
            : t("notice.peerBadKey", { name }),
      10000,
    );
  }

  /** Files reported as impossible to sync, waiting to be told in one notice. */
  private unsyncable: Array<{ path: string; reason: string }> = [];
  private unsyncableTimer: number | null = null;

  /**
   * Tell the user about files that cannot be synced (each is reported once
   * per run), in one notice for those reported together: a folder of such
   * files is reported file by file.
   */
  private notifyUnsyncable(path: string, reason: string): void {
    this.unsyncable.push({ path, reason });
    if (this.unsyncableTimer) return;
    this.unsyncableTimer = window.setTimeout(() => {
      this.unsyncableTimer = null;
      const [first, ...rest] = this.unsyncable;
      this.unsyncable = [];
      if (!first || this.unloaded) return;
      const more = rest.length > 0
        ? t("notice.cannotSyncMore", { count: rest.length })
        : "";
      new Notice(t("notice.cannotSync", { path: first.path, reason: first.reason, more }), 15000);
    }, 1000);
  }

  async removeManualPeer(address: string): Promise<void> {
    const normalized = address.trim();
    const nextPeers = this.settings.manualPeers.filter(
      (peer) => peer !== normalized,
    );
    if (nextPeers.length === this.settings.manualPeers.length) {
      return;
    }

    this.settings.manualPeers = nextPeers;
    await this.saveSettings();
    this.coordinator?.removeManualPeer(normalized);
  }

  /**
   * Restart a running sync shortly after a setting it reads at start (device
   * name, port) changed. Waits for typing to stop, so each keystroke does not
   * reconnect.
   */
  restartSyncSoon(): void {
    if (this.restartTimer) window.clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      if (this.coordinator && !this.unloaded) void this.startSync();
    }, 1500);
  }

  /** Apply an edited sync check interval to the running sync. */
  applySyncInterval(): void {
    this.coordinator?.setSyncInterval(this.settings.syncIntervalMs);
  }

  /** Push edited ignored paths to the running sync service. */
  applyIgnoredPaths(): void {
    this.coordinator?.updateIgnoredPaths(this.settings.ignoredPaths);
  }

  async startSync(): Promise<void> {
    if (this.coordinator) {
      await this.stopSync();
    }

    this.coordinator = new SyncCoordinator(this.app.vault, this.settings, {
      backupService: this.backupService!,
      syncLogService: this.syncLogService!,
      workspace: this.app.workspace,
      trash: (file) => this.app.fileManager.trashFile(file),
    });
    setLogSink(this.coordinator.eventLog);
    this.syncLogService?.setVersionStore(this.coordinator.versionStore);

    // A bulk deletion waits for the user: say so once per new batch.
    // The notice stays until those deletions are decided, then goes.
    let heldSeen = new Set<string>();
    const heldNotices: Array<{ ids: string[]; notice: Notice }> = [];
    const health = this.coordinator.health;
    this.coordinator.onHeldDeletionsChange((held) => {
      const fresh = held.filter((h) => !heldSeen.has(h.id));
      heldSeen = new Set(held.map((h) => h.id));
      // The panel's alert of a batch goes with the batch.
      health.keepHeld(heldSeen);
      for (let i = heldNotices.length - 1; i >= 0; i--) {
        if (heldNotices[i].ids.some((id) => heldSeen.has(id))) continue;
        heldNotices[i].notice.hide();
        heldNotices.splice(i, 1);
      }
      if (fresh.length > 0) {
        const count = fresh.reduce((n, h) => n + h.paths.length, 0);
        heldNotices.push({ ids: fresh.map((h) => h.id), notice: new Notice(t("notice.held", { count }), 0) });
      }
      for (const view of this.openSyncViews()) view.refresh();
    });

    this.coordinator.onStateChange(() => this.showStatus());

    // Two devices with one ID (settings copied with the vault) cannot sync
    // with each other: offer to give this one a new ID.
    this.coordinator.onDuplicateDevice((name) => {
      const text = t("notice.duplicateDevice", { name: name || "?" });
      // Shown for a minute: told again while the clash lasts (see
      // SyncCoordinator._reportDuplicateDevice), so a notice left from a
      // clash the other device already resolved does not linger.
      if (typeof createFragment !== "function") {
        new Notice(text, DUPLICATE_NOTICE_MS);
        return;
      }
      const notice = new Notice(
        createFragment((f) => {
          f.createDiv({ text });
          const btn = f.createEl("button", { text: t("set.regenerateId") });
          btn.onclick = () => {
            notice.hide();
            void this.regenerateDeviceId();
          };
        }),
        DUPLICATE_NOTICE_MS,
      );
    });

    // Alerts (plan 5.4): a notice at most once per kind per 10 minutes; the
    // sync panel lists them until they are gone. Held deletions have their
    // own notice above.
    this.coordinator.health.onAlert((a) => {
      if (a.kind === "bulk-held") return;
      new Notice(alertText(a), 10000);
    });
    let healthTimer: number | null = null;
    this.coordinator.health.onChange(() => {
      if (healthTimer) return;
      healthTimer = window.setTimeout(() => {
        healthTimer = null;
        this.showStatus();
      }, 500);
    });

    this.coordinator.onAuthFailed((failure) => this.notifyAuthFailure(failure));
    this.coordinator.onUnsyncableFile((path, reason) => this.notifyUnsyncable(path, reason));

    this.coordinator.onSyncEvent((msg: string) => {
      for (const view of this.openSyncViews()) view.addLog(msg);
    });

    await this.coordinator.start();
    // A recovery center opened before sync started shows the store now.
    this.recoveryCenter?.storeChanged();
    const error = this.coordinator.getStartError();
    if (error) new Notice(t("notice.error", { error }), 15000);
  }

  async stopSync(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.stop();
      this.coordinator = null;
      this.recoveryCenter?.storeChanged();
    }
    this.showStatus();
  }

  /** What the status bar and the sync view show, read from the running sync. */
  getSyncStatus(): SyncViewStatus {
    const coordinator = this.coordinator;
    return {
      state: coordinator?.getState() ?? "idle",
      devices: coordinator?.getConnectedPeers() ?? [],
      unreachable: coordinator?.getUnreachablePeers() ?? [],
      held: coordinator?.getHeldDeletions() ?? [],
      health: coordinator?.health.peers() ?? [],
      alerts: coordinator?.health.alerts() ?? [],
      summary: coordinator
        ? coordinator.health.summary(coordinator.getConnectedPeers().map((d) => d.deviceId))
        : undefined,
    };
  }

  /**
   * Writes a diagnostics file (plan 5.2) into the vault's
   * .lan-vault-sync/diagnostics folder and copies it to the clipboard where
   * that works. The sync key is masked.
   */
  async exportDiagnostics(): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    const coordinator = this.coordinator;
    try {
      const log = await (coordinator?.eventLog ?? new EventLog(adapter)).readAll(5000);
      const status = this.getSyncStatus();
      const text = buildDiagnostics({
        pluginVersion: this.manifest.version,
        platform: Platform.isMobile ? (Platform.isIosApp ? "ios" : "android") : Platform.isMacOS ? "darwin" : Platform.isWin ? "win32" : Platform.isLinux ? "linux" : "desktop",
        settings: this.settings,
        state: status.state,
        peers: status.devices.map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, ip: d.ip, port: d.port })),
        health: status.health ?? [],
        alerts: status.alerts ?? [],
        held: (status.held ?? []).map((h) => ({ id: h.id, kind: h.kind, count: h.paths.length, peer: h.peer })),
        history: coordinator?.versionStore ? await coordinator.versionStore.usage().catch(() => null) : null,
        tombstones: coordinator?.getTombstoneCount(),
        log,
      });
      const file = diagnosticsFileName();
      await ensureDirectory(adapter, DIAGNOSTICS_DIR);
      await adapter.write(file, text);
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        /* no clipboard: the file is enough */
      }
      new Notice(t(copied ? "notice.diagnosticsCopied" : "notice.diagnostics", { path: file }), 10000);
      return file;
    } catch (err) {
      new Notice(t("notice.error", { error: err instanceof Error ? err.message : String(err) }), 10000);
      return null;
    }
  }

  private showStatus(): void {
    const status = this.getSyncStatus();
    this.statusBar?.update(status.state, status.devices.length, status.unreachable, status.summary);
    for (const view of this.openSyncViews()) view.refresh();
    this.notifyUnreachable(status.unreachable);
  }

  /**
   * One notice per address and stretch of failures; the status bar and the
   * sync view show it for as long as it lasts. Phones have no status bar.
   */
  private notifyUnreachable(addresses: string[]): void {
    for (const address of this.unreachableNotified) {
      if (!addresses.includes(address)) this.unreachableNotified.delete(address);
    }
    const fresh = addresses.filter((address) => !this.unreachableNotified.has(address));
    if (fresh.length === 0) return;
    for (const address of fresh) this.unreachableNotified.add(address);
    new Notice(
      t("notice.unreachable", { addresses: fresh.join(", ") }) +
        // In testing this was a phone without local network permission:
        // every connection failed at once.
        (canUseNodeRuntime()
          ? ""
          : t("notice.localNetworkHint")),
      15000,
    );
  }

  async manualFullSync(
    onProgress: (percent: number, message: string) => void,
  ): Promise<void> {
    if (!this.coordinator) {
      onProgress(100, t("progress.not-running"));
      return;
    }
    await this.coordinator.manualFullSync(onProgress);
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(SYNC_VIEW_TYPE)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: SYNC_VIEW_TYPE, active: true });
      }
    }

    if (leaf) {
      await workspace.revealLeaf(leaf);
    }
  }

  /** The sync panels open in the workspace. */
  private openSyncViews(): SyncView[] {
    return this.app.workspace
      .getLeavesOfType(SYNC_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is SyncView => view instanceof SyncView);
  }

  async activateSyncLogView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(SYNC_LOG_VIEW_TYPE)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: SYNC_LOG_VIEW_TYPE, active: true });
      }
    }

    if (leaf) {
      await workspace.revealLeaf(leaf);
    }
  }

  async activateRecoveryCenter(): Promise<void> {
    await openRecoveryCenter(this);
  }
}
