import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import { SYNC_LOG_VIEW_TYPE } from '../constants';
import { SyncLogEntry, SyncLogEntryType } from '../types';
import { SyncLogService } from '../sync-log/sync-log-service';
import { SyncLogModal } from './sync-log-modal';

export class SyncLogView extends ItemView {
  private filterType: SyncLogEntryType | 'all' = 'all';
  private searchQuery = '';

  constructor(
    leaf: WorkspaceLeaf,
    private syncLogService: SyncLogService,
  ) {
    super(leaf);
    this.syncLogService.onChange(() => this.render());
  }

  getViewType(): string {
    return SYNC_LOG_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Sync Log';
  }

  getIcon(): string {
    return 'file-clock';
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    if (!container) return;
    container.empty();
    container.addClass('sync-log-container');

    // Filter bar
    this._renderFilterBar(container);

    // Entries
    const entries = this._getFilteredEntries();
    if (entries.length === 0) {
      container.createEl('p', { text: '暂无同步日志', cls: 'lan-sync-muted' });
      return;
    }

    // Group by date
    const grouped = this._groupByDate(entries);
    for (const [date, items] of grouped) {
      const dateGroup = container.createDiv({ cls: 'sync-log-date-group' });
      dateGroup.createEl('h5', { text: date, cls: 'sync-log-date-header' });
      for (const entry of items) {
        this._renderEntry(dateGroup, entry);
      }
    }
  }

  private _renderFilterBar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: 'sync-log-filter-bar' });

    // Type filter
    const select = bar.createEl('select', { cls: 'sync-log-filter-select' });
    const options: [string, string][] = [
      ['all', '全部类型'],
      ['remote-overwrite', '远程覆写'],
      ['remote-delete', '远程删除'],
      ['local-send', '本地发送'],
      ['initial-sync-receive', '初始同步'],
      ['conflict-backup', '冲突备份'],
    ];
    for (const [value, label] of options) {
      const opt = select.createEl('option', { text: label });
      opt.value = value;
      if (value === this.filterType) opt.selected = true;
    }
    select.addEventListener('change', () => {
      this.filterType = select.value as SyncLogEntryType | 'all';
      this.render();
    });

    // Search
    const searchInput = bar.createEl('input', {
      type: 'text',
      placeholder: '搜索文件路径...',
      cls: 'sync-log-search-input',
    });
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.render();
    });
  }

  private _getFilteredEntries(): SyncLogEntry[] {
    let entries = this.syncLogService.getEntries();
    if (this.filterType !== 'all') {
      entries = entries.filter(e => e.type === this.filterType);
    }
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      entries = entries.filter(e => e.path.toLowerCase().includes(q));
    }
    return entries;
  }

  private _groupByDate(entries: SyncLogEntry[]): [string, SyncLogEntry[]][] {
    const groups = new Map<string, SyncLogEntry[]>();
    for (const entry of entries) {
      const date = new Date(entry.timestamp).toLocaleDateString();
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date)!.push(entry);
    }
    return Array.from(groups.entries());
  }

  private _renderEntry(parent: HTMLElement, entry: SyncLogEntry): void {
    const row = parent.createDiv({ cls: `sync-log-entry sync-log-type-${entry.type}` });

    // Icon
    const iconEl = row.createSpan({ cls: 'sync-log-icon' });
    setIcon(iconEl, this._getIcon(entry.type));

    // Info
    const info = row.createDiv({ cls: 'sync-log-info' });
    info.createDiv({ text: entry.path, cls: 'sync-log-path' });
    const meta = info.createDiv({ cls: 'sync-log-meta' });
    meta.createSpan({ text: this._typeLabel(entry.type), cls: `sync-log-type-label sync-log-label-${entry.type}` });
    if (entry.deviceName) {
      meta.createSpan({ text: ` · ${entry.deviceName}` });
    }
    meta.createSpan({ text: ` · ${new Date(entry.timestamp).toLocaleTimeString()}` });

    // Actions
    const actions = row.createDiv({ cls: 'sync-log-actions' });

    if (entry.hasSnapshot) {
      const previewBtn = actions.createEl('button', { cls: 'sync-log-action-btn', title: '预览' });
      setIcon(previewBtn, 'eye');
      previewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._previewEntry(entry);
      });

      const restoreBtn = actions.createEl('button', { cls: 'sync-log-action-btn', title: '还原' });
      setIcon(restoreBtn, 'undo');
      restoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._restoreEntry(entry);
      });

      const copyBtn = actions.createEl('button', { cls: 'sync-log-action-btn', title: '复制内容' });
      setIcon(copyBtn, 'copy');
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._copyEntryContent(entry);
      });
    }
  }

  private _previewEntry(entry: SyncLogEntry): void {
    const modal = new SyncLogModal(this.app, entry, this.syncLogService);
    modal.open();
  }

  private async _restoreEntry(entry: SyncLogEntry): Promise<void> {
    const success = await this.syncLogService.restoreFromSnapshot(entry);
    if (success) {
      new Notice(`已还原: ${entry.path}`);
    } else {
      new Notice(`还原失败: ${entry.path}`);
    }
  }

  private async _copyEntryContent(entry: SyncLogEntry): Promise<void> {
    const content = await this.syncLogService.readSnapshotContent(entry);
    if (content !== null) {
      await navigator.clipboard.writeText(content);
      new Notice('已复制到剪贴板');
    } else {
      new Notice('无法读取快照内容');
    }
  }

  private _getIcon(type: SyncLogEntryType): string {
    switch (type) {
      case 'remote-overwrite': return 'download';
      case 'remote-delete': return 'trash';
      case 'local-send': return 'upload';
      case 'initial-sync-receive': return 'download-cloud';
      case 'conflict-backup': return 'shield';
    }
  }

  private _typeLabel(type: SyncLogEntryType): string {
    switch (type) {
      case 'remote-overwrite': return '远程覆写';
      case 'remote-delete': return '远程删除';
      case 'local-send': return '本地发送';
      case 'initial-sync-receive': return '初始同步';
      case 'conflict-backup': return '冲突备份';
    }
  }
}
