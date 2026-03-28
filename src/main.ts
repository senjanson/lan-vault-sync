import { Plugin, WorkspaceLeaf } from 'obsidian';
import { LANSyncSettings, DEFAULT_SETTINGS, SyncState } from './types';
import { SYNC_VIEW_TYPE } from './constants';
import { setDebugEnabled } from './logger';
import { SyncCoordinator } from './sync/sync-coordinator';
import { StatusBar } from './ui/status-bar';
import { LANSyncSettingTab } from './ui/settings-tab';
import { SyncView } from './ui/sync-view';

function generateDeviceId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

export default class LANSyncPlugin extends Plugin {
  settings: LANSyncSettings = DEFAULT_SETTINGS;
  private coordinator: SyncCoordinator | null = null;
  private statusBar: StatusBar | null = null;
  private syncView: SyncView | null = null;

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

    setDebugEnabled(this.settings.enableDebugLog);

    // Register view
    this.registerView(SYNC_VIEW_TYPE, (leaf: WorkspaceLeaf) => {
      this.syncView = new SyncView(leaf);
      return this.syncView;
    });

    // Status bar
    this.statusBar = new StatusBar(this);

    // Settings tab
    this.addSettingTab(new LANSyncSettingTab(this.app, this));

    // Commands
    this.addCommand({
      id: 'lan-sync-toggle',
      name: 'Toggle LAN Sync',
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
      id: 'lan-sync-open-panel',
      name: 'Open Sync Panel',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'lan-sync-add-peer',
      name: 'Add Manual Peer',
      callback: () => {
        // Simple prompt for adding a peer
        const input = prompt('Enter peer address (ip:port):');
        if (input && input.includes(':')) {
          this.settings.manualPeers.push(input.trim());
          this.saveSettings();
          this.coordinator?.addManualPeer(input.trim());
        }
      },
    });

    // Auto-start if enabled
    if (this.settings.enabled) {
      // Delay to let Obsidian finish loading
      setTimeout(() => this.startSync(), 2000);
    }
  }

  async onunload(): Promise<void> {
    await this.stopSync();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    setDebugEnabled(this.settings.enableDebugLog);
  }

  async startSync(): Promise<void> {
    if (this.coordinator) {
      await this.stopSync();
    }

    this.coordinator = new SyncCoordinator(this.app.vault, this.settings);

    this.coordinator.onStateChange((state: SyncState) => {
      const peerCount = this.coordinator?.getConnectedDevices().length ?? 0;
      this.statusBar?.update(state, peerCount);
      this.syncView?.setSyncState(state);
    });

    this.coordinator.onSyncEvent((msg: string) => {
      this.syncView?.addLog(msg);
    });

    await this.coordinator.start();
  }

  async stopSync(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.stop();
      this.coordinator = null;
    }
    this.statusBar?.update('idle');
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
}
