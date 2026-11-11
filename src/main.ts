import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { LANSyncSettings, DEFAULT_SETTINGS, SyncState } from "./types";
import {
  PLUGIN_ID,
  SYNC_VIEW_TYPE,
  SYNC_LOG_VIEW_TYPE,
  WS_PORT_MIN,
  WS_PORT_MAX,
} from "./constants";
import { setDebugEnabled } from "./logger";
import { parsePeerAddress } from "./discovery/manual-peers";
import { SyncCoordinator } from "./sync/sync-coordinator";
import { generateSyncKey, normalizeSyncKey } from "./transport/auth";
import type { AuthFailure } from "./transport/connection-manager";
import { confirmDialog } from "./ui/confirm-modal";
import { ConflictBackupService } from "./conflict/conflict-backup-service";
import { SyncLogService } from "./sync-log/sync-log-service";
import { StatusBar } from "./ui/status-bar";
import { LANSyncSettingTab } from "./ui/settings-tab";
import { SyncView } from "./ui/sync-view";
import { SyncLogView } from "./ui/sync-log-view";

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
      this.syncView = new SyncView(leaf);
      return this.syncView;
    });

    // Register sync log view
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
      id: "lan-vault-sync-toggle",
      name: "Toggle LAN Vault Sync",
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
      id: "lan-vault-sync-open-panel",
      name: "Open Sync Panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "lan-vault-sync-open-sync-log",
      name: "Open Sync Log",
      callback: () => this.activateSyncLogView(),
    });

    this.addCommand({
      id: "lan-vault-sync-add-peer",
      name: "Add Manual Peer",
      callback: async () => {
        // Simple prompt for adding a peer
        const input = prompt("Enter peer address (ip:port):");
        if (input) {
          await this.addManualPeer(input);
        }
      },
    });

    // Protocol handler: obsidian://lan-vault-sync?address=ip:port&key=...
    // Note: Obsidian overwrites params.action with the handler name ("lan-vault-sync"),
    // so we cannot use a custom action parameter — just check for address directly.
    this.registerObsidianProtocolHandler(PLUGIN_ID, async (params) => {
      await this.handleProtocolParams(params);
    });

    // Auto-start if enabled
    if (this.settings.enabled) {
      // Delay to let Obsidian finish loading
      setTimeout(() => this.startSync(), 2000);
    }
  }

  async onunload(): Promise<void> {
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
      new Notice(`LAN Sync: Failed to add peer. Invalid address: ${address}`);
      return;
    }

    // Any web page or message can open an obsidian:// link, so nothing is
    // changed without the user's confirmation.
    const key = params.key ? params.key.trim() : "";
    const changesKey =
      !!key && normalizeSyncKey(key) !== normalizeSyncKey(this.settings.syncKey);
    const lines = [`Add the device at ${address} as a sync peer?`];
    if (changesKey) {
      lines.push(
        "This also sets this device's sync key to the one in the link. Other devices that use the current key will stop syncing with this one until they get the new key.",
      );
    }
    lines.push("Only continue if you opened this link yourself, for example by scanning the QR code on your own device.");
    const ok = await confirmDialog(this.app, "Pair with device", lines, "Pair");
    if (!ok) return;

    if (changesKey) {
      await this.setSyncKey(key);
    }
    const added = await this.addManualPeer(address);
    if (added) {
      new Notice(`LAN Sync: Peer ${address} added`);
    } else {
      new Notice(`LAN Sync: Failed to add peer. Invalid address: ${address}`);
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
        ? `LAN Sync: ${name} runs an older version of the plugin. Update it on that device to sync.`
        : `LAN Sync: ${name} has a different sync key. Use the same key on both devices (Settings → LAN Vault Sync → Sync key).`,
      10000,
    );
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
    });

    this.coordinator.onStateChange((state: SyncState) => {
      const peerCount = this.coordinator?.getConnectedDevices().length ?? 0;
      this.statusBar?.update(state, peerCount);
      this.syncView?.setSyncState(state);
      this.syncView?.setDevices(this.coordinator?.getDiscoveredDevices() ?? []);
    });

    this.coordinator.onAuthFailed((failure) => this.notifyAuthFailure(failure));

    this.coordinator.onSyncEvent((msg: string) => {
      this.syncView?.addLog(msg);
      this.syncView?.setDevices(this.coordinator?.getDiscoveredDevices() ?? []);
    });

    await this.coordinator.start();
  }

  async stopSync(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.stop();
      this.coordinator = null;
    }
    this.statusBar?.update("idle");
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
}
