import { ItemView, WorkspaceLeaf } from 'obsidian';
import { SYNC_VIEW_TYPE } from '../constants';
import { SyncState, DeviceInfo } from '../types';
import { canUseNodeRuntime } from '../utils/runtime';
import { t } from '../i18n';
import type { HeldDeletion } from '../sync/delete-breaker';
import type { Alert, HealthSummary, PeerHealth } from '../diagnostics/health';

export interface SyncViewStatus {
  state: SyncState;
  /** Devices connected now. */
  devices: DeviceInfo[];
  /** Addresses added by hand that cannot be reached; still retried. */
  unreachable: string[];
  /** Deletions held until the user confirms them. */
  held?: HeldDeletion[];
  /** How each peer's files compared at the last exchange. */
  health?: PeerHealth[];
  alerts?: Alert[];
  summary?: HealthSummary;
}

export interface SyncViewActions {
  resolveHeld(id: string, choice: 'delete' | 'keep'): Promise<void>;
  dismissAlert?(key: string): void;
  exportDiagnostics?(): Promise<unknown>;
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
  constructor(
    leaf: WorkspaceLeaf,
    private getStatus: () => SyncViewStatus,
    private actions?: SyncViewActions,
  ) {
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
    const { state, devices, unreachable, held = [], health = [], alerts = [] } = this.getStatus();

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

    if (held.length > 0) this._renderHeld(container as HTMLElement, held);

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

    this._renderHealth(container as HTMLElement, devices, health, alerts);

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

  /** Plan 5.3/5.4: per-peer comparison and the alerts still standing. */
  private _renderHealth(container: HTMLElement, devices: DeviceInfo[], health: PeerHealth[], alerts: Alert[]): void {
    const section = container.createDiv({ cls: 'lan-sync-section' });
    section.createEl('h4', { text: t('health.title') });
    const connected = new Set(devices.map((d) => d.deviceId));
    const shown = health.filter((p) => connected.has(p.id) && p.lastExchange !== undefined);
    if (shown.length === 0) {
      section.createEl('p', { text: t('health.noPeers'), cls: 'lan-sync-muted' });
    } else {
      const list = section.createEl('ul', { cls: 'lan-sync-device-list' });
      for (const p of shown) {
        const name = devices.find((d) => d.deviceId === p.id)?.deviceName || p.name || p.id;
        const time = new Date(p.lastExchange!).toLocaleTimeString();
        const parts = [
          p.unsynced.length > 0
            ? t('health.differing', { name, count: p.unsynced.length, time })
            : p.differing > 0
              ? t('health.pending', { name, time })
              : t('health.consistent', { name, time }),
        ];
        if (p.waiting > 0) parts.push(t('health.waiting', { count: p.waiting }));
        if (p.clockOffsetMs !== undefined && Math.abs(p.clockOffsetMs) > 30000) {
          parts.push(t('health.clock', { secs: Math.round(Math.abs(p.clockOffsetMs) / 1000) }));
        }
        const item = list.createEl('li', { text: parts.join(' · ') });
        if (p.unsynced.length > 0) {
          item.addClass('lan-sync-state-error');
          const files = item.createEl('ul');
          for (const f of p.unsynced.slice(0, 5)) files.createEl('li', { text: f });
        }
      }
    }
    if (alerts.length > 0) {
      section.createEl('h5', { text: t('health.alerts') });
      for (const a of alerts) {
        const row = section.createDiv({ cls: 'lan-sync-alert' });
        const time = new Date(a.last).toLocaleTimeString();
        row.createSpan({
          text: `${time} ${t(`alert.${a.kind}`, { msg: a.msg })}${a.count > 1 ? ` (×${a.count})` : ''}`,
          cls: 'lan-sync-state-error',
        });
        if (this.actions?.dismissAlert) {
          const btn = row.createEl('button', { text: t('health.dismiss') });
          btn.onclick = () => {
            this.actions?.dismissAlert?.(a.key);
            this.render();
          };
        }
      }
    }
    if (this.actions?.exportDiagnostics) {
      const btn = section.createEl('button', { text: t('health.export') });
      btn.onclick = () => void this.actions?.exportDiagnostics?.();
    }
  }

  private _renderHeld(container: HTMLElement, held: HeldDeletion[]): void {
    const section = container.createDiv({ cls: 'lan-sync-section' });
    section.createEl('h4', { text: t('view.held', { count: held.length }) });
    for (const h of held) {
      const box = section.createDiv({ cls: 'lan-sync-held' });
      box.createEl('p', {
        text: h.kind === 'inferred'
          ? t('view.heldInferred', { count: h.paths.length })
          : t('view.heldIncoming', { count: h.paths.length, peer: h.peer ?? h.deviceId ?? '?' }),
        cls: 'lan-sync-state-error',
      });
      const list = box.createEl('ul');
      for (const p of h.paths.slice(0, 5)) list.createEl('li', { text: p });
      if (h.paths.length > 5) list.createEl('li', { text: t('view.heldMore', { count: h.paths.length - 5 }) });
      const row = box.createDiv({ cls: 'lan-sync-held-actions' });
      const del = row.createEl('button', { text: t('view.heldDelete'), cls: 'mod-warning' });
      const keep = row.createEl('button', { text: t('view.heldKeep'), cls: 'mod-cta' });
      const act = (choice: 'delete' | 'keep') => async () => {
        del.disabled = true;
        keep.disabled = true;
        await this.actions?.resolveHeld(h.id, choice);
        this.render();
      };
      del.onclick = act('delete');
      keep.onclick = act('keep');
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
