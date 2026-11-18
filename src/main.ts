import { Notice, Platform, Plugin, WorkspaceLeaf } from "obsidian";
import { LANSyncSettings, DEFAULT_SETTINGS } from "./types";
import {
  PLUGIN_ID,
  SYNC_VIEW_TYPE,
  SYNC_LOG_VIEW_TYPE,
  WS_PORT_MIN,
  WS_PORT_MAX,
} from "./constants";
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
import { ensureDirectory } from "./utils/path-utils";

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

export default class LANSyncPlugin extends Plugin {
  settings: LANSyncSettings = DEFAULT_SETTINGS;
  private coordinator: SyncCoordinator | null = null;
  private statusBar: StatusBar | null = null;
  private syncView: SyncView | null = null;
  private syncLogView: SyncLogView | null = null;
  private backupService: ConflictBackupService | null = null;
  syncLogService: SyncLogService | null = null;
  /** Last notice time per refused address, so retries don't spam notices. */
  private authNoticeAt = new Map<string, number>();
  /** Addresses the user was told cannot be reached, until they connect. */
  private unreachableNotified = new Set<string>();
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private unloaded = false;

  async onload(): Promise<void> {
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
      this.syncView = new SyncView(leaf, () => this.getSyncStatus(), {
        resolveHeld: async (id, choice) => {
          await this.coordinator?.resolveHeldDeletions(id, choice);
        },
        dismissAlert: (key) => this.coordinator?.health.dismiss(key),
        exportDiagnostics: () => this.exportDiagnostics(),
      });
      return this.syncView;
    });

    // Register sync log view
    // Recovery center: old versions kept before sync changed a file.
    registerRecoveryCenter(this, () => this.coordinator?.versionStore ?? null);

    this.registerView(SYNC_LOG_VIEW_TYPE, (leaf: WorkspaceLeaf) => {
      this.syncLogView = new SyncLogView(leaf, this.syncLogService!);
      return this.syncLogView;
    });

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
        this.startTimer = setTimeout(() => {
          this.startTimer = null;
          void this.startSync();
        }, 2000);
      });
    }
  }

  async onunload(): Promise<void> {
    this.unloaded = true;
    setLogSink(null);
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    await this.stopSync();
    await this.syncLogService?.flush();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
    const last = this.authNoticeAt.get(failure.address) ?? 0;
    if (now - last < 10 * 60_000) return;
    this.authNoticeAt.set(failure.address, now);
    const name = failure.deviceName || failure.address;
    new Notice(
      failure.reason === "outdated"
        ? t("notice.peerOutdated", { name })
        : failure.reason === "newer"
          ? t("notice.peerNewer", { name })
          : t("notice.peerBadKey", { name }),
      10000,
    );
  }

  /** Files reported as impossible to sync, waiting to be told in one notice. */
  private unsyncable: Array<{ path: string; reason: string }> = [];
  private unsyncableTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Tell the user about files that cannot be synced (each is reported once
   * per run), in one notice for those reported together: a folder of such
   * files is reported file by file.
   */
  private notifyUnsyncable(path: string, reason: string): void {
    this.unsyncable.push({ path, reason });
    if (this.unsyncableTimer) return;
    this.unsyncableTimer = setTimeout(() => {
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
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
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
    let heldSeen = new Set<string>();
    this.coordinator.onHeldDeletionsChange((held) => {
      const fresh = held.filter((h) => !heldSeen.has(h.id));
      heldSeen = new Set(held.map((h) => h.id));
      if (fresh.length > 0) {
        const count = fresh.reduce((n, h) => n + h.paths.length, 0);
        new Notice(t("notice.held", { count }), 0);
      }
      this.syncView?.refresh();
    });

    this.coordinator.onStateChange(() => this.showStatus());

    // Alerts (plan 5.4): a notice at most once per kind per 10 minutes; the
    // sync panel lists them until they are gone. Held deletions have their
    // own notice above.
    this.coordinator.health.onAlert((a) => {
      if (a.kind === "bulk-held") return;
      new Notice(t(`alert.${a.kind}`, { msg: a.msg }), 10000);
    });
    let healthTimer: ReturnType<typeof setTimeout> | null = null;
    this.coordinator.health.onChange(() => {
      if (healthTimer) return;
      healthTimer = setTimeout(() => {
        healthTimer = null;
        this.showStatus();
      }, 500);
    });

    this.coordinator.onAuthFailed((failure) => this.notifyAuthFailure(failure));
    this.coordinator.onUnsyncableFile((path, reason) => this.notifyUnsyncable(path, reason));

    this.coordinator.onSyncEvent((msg: string) => {
      this.syncView?.addLog(msg);
    });

    await this.coordinator.start();
    const error = this.coordinator.getStartError();
    if (error) new Notice(t("notice.error", { error }), 15000);
  }

  async stopSync(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.stop();
      this.coordinator = null;
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
    const adapter = this.app.vault.adapter as any;
    const coordinator = this.coordinator;
    try {
      const log = await (coordinator?.eventLog ?? new EventLog(adapter)).readAll(5000);
      const status = this.getSyncStatus();
      const text = buildDiagnostics({
        pluginVersion: this.manifest.version,
        platform: Platform.isMobile ? (Platform.isIosApp ? "ios" : "android") : ((globalThis as any).process?.platform ?? "desktop"),
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
    this.syncView?.refresh();
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
      onProgress(100, "Sync is not running");
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
      workspace.revealLeaf(leaf);
    }
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
      workspace.revealLeaf(leaf);
    }
  }

  async activateRecoveryCenter(): Promise<void> {
    await openRecoveryCenter(this);
  }
}
