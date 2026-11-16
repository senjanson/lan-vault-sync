import { ItemView, WorkspaceLeaf } from 'obsidian';
import { SYNC_VIEW_TYPE } from '../constants';
import { SyncState, DeviceInfo } from '../types';
import { canUseNodeRuntime } from '../utils/runtime';

export interface SyncViewStatus {
  state: SyncState;
  /** Devices connected now. */
  devices: DeviceInfo[];
  /** Addresses added by hand that cannot be reached; still retried. */
  unreachable: string[];
}

export class SyncView extends ItemView {
  private logs: string[] = [];

  /**
   * The status is read when the view renders rather than kept from events:
   * a view opened while sync runs has missed every event before it.
   */
  constructor(leaf: WorkspaceLeaf, private getStatus: () => SyncViewStatus) {
    super(leaf);
  }

  getViewType(): string {
    return SYNC_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'LAN Sync';
  }

  getIcon(): string {
    return 'refresh-cw';
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  /** Show the current status. */
  refresh(): void {
    this.render();
  }

  addLog(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.logs.unshift(`[${timestamp}] ${message}`);
    // Keep last 100 entries
    if (this.logs.length > 100) this.logs.pop();
    this.render();
  }

  private render(): void {
    const container = this.containerEl.children[1];
    if (!container) return;
    container.empty();
    const { state, devices, unreachable } = this.getStatus();

    // Status section
    const statusSection = container.createDiv({ cls: 'lan-sync-section' });
    statusSection.createEl('h4', { text: 'Status' });
    const statusBadge = statusSection.createDiv({ cls: 'lan-sync-status-badge' });
    statusBadge.createSpan({ text: this._stateLabel(state), cls: `lan-sync-state-${state}` });
    for (const address of unreachable) {
      statusSection.createEl('p', {
        text: `Cannot reach ${address}. Retrying in the background.`,
        cls: 'lan-sync-state-error',
      });
    }
    if (unreachable.length > 0 && !canUseNodeRuntime()) {
      statusSection.createEl('p', {
        text: 'If that device is on and on the same network, check that Obsidian is allowed to use the local network (iPhone: Settings → Privacy & Security → Local Network).',
        cls: 'lan-sync-muted',
      });
    }

    // Devices section
    const devicesSection = container.createDiv({ cls: 'lan-sync-section' });
    devicesSection.createEl('h4', { text: `Connected Devices (${devices.length})` });

    if (devices.length === 0) {
      devicesSection.createEl('p', { text: 'No devices connected', cls: 'lan-sync-muted' });
    } else {
      const list = devicesSection.createEl('ul', { cls: 'lan-sync-device-list' });
      for (const device of devices) {
        const item = list.createEl('li');
        item.createSpan({ text: device.deviceName || device.deviceId, cls: 'lan-sync-device-name' });
        item.createSpan({ text: ` (${device.ip}:${device.port})`, cls: 'lan-sync-device-addr' });
      }
    }

    // Logs section
    const logsSection = container.createDiv({ cls: 'lan-sync-section' });
    logsSection.createEl('h4', { text: 'Sync Log' });
    const logContainer = logsSection.createDiv({ cls: 'lan-sync-logs' });

    if (this.logs.length === 0) {
      logContainer.createEl('p', { text: 'No events yet', cls: 'lan-sync-muted' });
    } else {
      for (const log of this.logs.slice(0, 20)) {
        logContainer.createDiv({ text: log, cls: 'lan-sync-log-entry' });
      }
    }
  }

  private _stateLabel(state: SyncState): string {
    switch (state) {
      case 'idle': return '⏸ Idle';
      case 'discovering': return '🔍 Discovering...';
      case 'connecting': return '🔗 Connecting...';
      case 'initial-sync': return '🔄 Initial Sync...';
      case 'watching': return '✅ Syncing';
      case 'error': return '⚠️ Error';
    }
  }
}
