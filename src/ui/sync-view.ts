import { ItemView, WorkspaceLeaf } from 'obsidian';
import { SYNC_VIEW_TYPE } from '../constants';
import { SyncState, DeviceInfo } from '../types';
import { canUseNodeRuntime } from '../utils/runtime';
import { t } from '../i18n';

export interface SyncViewStatus {
  state: SyncState;
  /** Devices connected now. */
  devices: DeviceInfo[];
  /** Addresses added by hand that cannot be reached; still retried. */
  unreachable: string[];
}

/** How long new log lines wait to be shown, so that they are drawn together. */
const RENDER_DELAY_MS = 250;

export class SyncView extends ItemView {
  private logs: string[] = [];
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

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
    // A bulk change logs an event per file; the view is drawn again at most
    // a few times a second, not once for each.
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, RENDER_DELAY_MS);
  }

  private render(): void {
    const container = this.containerEl.children[1];
    if (!container) return;
    container.empty();
    const { state, devices, unreachable } = this.getStatus();

    // Status section
    const statusSection = container.createDiv({ cls: 'lan-sync-section' });
    statusSection.createEl('h4', { text: t('view.status') });
    const statusBadge = statusSection.createDiv({ cls: 'lan-sync-status-badge' });
    statusBadge.createSpan({ text: this._stateLabel(state), cls: `lan-sync-state-${state}` });
    for (const address of unreachable) {
      statusSection.createEl('p', {
        text: t('view.cannotReach', { address }),
        cls: 'lan-sync-state-error',
      });
    }
    if (unreachable.length > 0 && !canUseNodeRuntime()) {
      statusSection.createEl('p', {
        text: t('view.localNetworkHint'),
        cls: 'lan-sync-muted',
      });
    }

    // Devices section
    const devicesSection = container.createDiv({ cls: 'lan-sync-section' });
    devicesSection.createEl('h4', { text: t('view.devices', { count: devices.length }) });

    if (devices.length === 0) {
      devicesSection.createEl('p', { text: t('view.noDevices'), cls: 'lan-sync-muted' });
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
    logsSection.createEl('h4', { text: t('view.events') });
    const logContainer = logsSection.createDiv({ cls: 'lan-sync-logs' });

    if (this.logs.length === 0) {
      logContainer.createEl('p', { text: t('view.noEvents'), cls: 'lan-sync-muted' });
    } else {
      for (const log of this.logs.slice(0, 20)) {
        logContainer.createDiv({ text: log, cls: 'lan-sync-log-entry' });
      }
    }
  }

  private _stateLabel(state: SyncState): string {
    switch (state) {
      case 'idle': return t('state.idle');
      case 'discovering': return t('state.discovering');
      case 'connecting': return t('state.connecting');
      case 'initial-sync': return t('state.initial-sync');
      case 'watching': return t('state.watching');
      case 'error': return t('state.error');
    }
  }
}
