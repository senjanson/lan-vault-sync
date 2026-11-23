import { ItemView, WorkspaceLeaf, Notice, setIcon, TFile } from "obsidian";
import { SYNC_LOG_VIEW_TYPE } from "../constants";
import { SyncLogEntry, SyncLogEntryType } from "../types";
import { SyncLogService } from "../sync-log/sync-log-service";
import { SyncLogModal } from "./sync-log-modal";
import { t, formatDate, formatTime } from "../i18n";

export class SyncLogView extends ItemView {
  private filterType: SyncLogEntryType | "all" = "all";
  private searchQuery = "";
  private renderTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private syncLogService: SyncLogService,
  ) {
    super(leaf);
    // A bulk change from a peer adds an entry per file; drawing every entry
    // again for each one made the change itself slow on a phone.
    this.syncLogService.onChange(() => {
      if (this.renderTimer) return;
      this.renderTimer = window.setTimeout(() => {
        this.renderTimer = null;
        this.render();
      }, 250);
    });
  }

  getViewType(): string {
    return SYNC_LOG_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("log.title");
  }

  getIcon(): string {
    return "file-clock";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    if (!container) return;
    container.empty();
    container.addClass("sync-log-container");

    // Filter bar
    this._renderFilterBar(container);

    // Entries
    const entries = this._getFilteredEntries();
    if (entries.length === 0) {
      container.createEl("p", { text: t("log.empty"), cls: "lan-sync-muted" });
      return;
    }

    // Group by date
    const grouped = this._groupByDate(entries);
    for (const [date, items] of grouped) {
      const dateGroup = container.createDiv({ cls: "sync-log-date-group" });
      dateGroup.createEl("h5", { text: date, cls: "sync-log-date-header" });
      for (const entry of items) {
        this._renderEntry(dateGroup, entry);
      }
    }
  }

  private _renderFilterBar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "sync-log-filter-bar" });

    // Type filter
    const select = bar.createEl("select", { cls: "sync-log-filter-select" });
    const options: [string, string][] = [
      ["all", t("log.allTypes")],
      ["remote-overwrite", t("log.type.remote-overwrite")],
      ["remote-delete", t("log.type.remote-delete")],
      ["local-send", t("log.type.local-send")],
      ["initial-sync-receive", t("log.type.initial-sync-receive")],
      ["conflict-backup", t("log.type.conflict-backup")],
    ];
    for (const [value, label] of options) {
      const opt = select.createEl("option", { text: label });
      opt.value = value;
      if (value === this.filterType) opt.selected = true;
    }
    select.addEventListener("change", () => {
      this.filterType = select.value as SyncLogEntryType | "all";
      this.render();
    });

    // Search
    const searchInput = bar.createEl("input", {
      type: "text",
      placeholder: t("log.search"),
      cls: "sync-log-search-input",
    });
    searchInput.value = this.searchQuery;
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      this.render();
    });
  }

  private _getFilteredEntries(): SyncLogEntry[] {
    let entries = this.syncLogService.getEntries();
    if (this.filterType !== "all") {
      entries = entries.filter((e) => e.type === this.filterType);
    }
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      entries = entries.filter((e) => e.path.toLowerCase().includes(q));
    }
    return entries;
  }

  private _groupByDate(entries: SyncLogEntry[]): [string, SyncLogEntry[]][] {
    const groups = new Map<string, SyncLogEntry[]>();
    for (const entry of entries) {
      const date = formatDate(entry.timestamp);
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date)!.push(entry);
    }
    return Array.from(groups.entries());
  }

  private _renderEntry(parent: HTMLElement, entry: SyncLogEntry): void {
    const row = parent.createDiv({
      cls: `sync-log-entry sync-log-type-${entry.type}`,
    });

    // Icon
    const iconEl = row.createSpan({ cls: "sync-log-icon" });
    setIcon(iconEl, this._getIcon(entry.type));

    // Info
    const info = row.createDiv({ cls: "sync-log-info" });
    info.createDiv({ text: entry.path, cls: "sync-log-path" });
    const meta = info.createDiv({ cls: "sync-log-meta" });
    meta.createSpan({
      text: this._typeLabel(entry.type),
      cls: `sync-log-type-label sync-log-label-${entry.type}`,
    });
    if (entry.deviceName) {
      meta.createSpan({ text: ` · ${entry.deviceName}` });
    }
    meta.createSpan({
      text: ` · ${formatTime(entry.timestamp)}`,
    });

    // Actions
    const actions = row.createDiv({ cls: "sync-log-actions" });

    if (entry.hasSnapshot) {
      const previewBtn = actions.createEl("button", {
        cls: "sync-log-action-btn",
        title: t("log.preview"),
      });
      setIcon(previewBtn, "eye");
      previewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._previewEntry(entry);
      });

      const restoreBtn = actions.createEl("button", {
        cls: "sync-log-action-btn",
        title: t("log.restore"),
      });
      setIcon(restoreBtn, "undo");
      restoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this._restoreEntry(entry);
      });

      const copyBtn = actions.createEl("button", {
        cls: "sync-log-action-btn",
        title: t("log.copyContent"),
      });
      setIcon(copyBtn, "copy");
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this._copyEntryContent(entry);
      });
    } else {
      const viewBtn = actions.createEl("button", {
        cls: "sync-log-action-btn",
        title: t("log.openFile"),
      });
      setIcon(viewBtn, "eye");
      viewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._openFile(entry.path);
      });

      const copyPathBtn = actions.createEl("button", {
        cls: "sync-log-action-btn",
        title: t("log.copyPath"),
      });
      setIcon(copyPathBtn, "copy");
      copyPathBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(entry.path);
        new Notice(t("log.pathCopied"));
      });
    }
  }

  private _openFile(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice(t("log.fileMissing", { path }));
    }
  }

  private _previewEntry(entry: SyncLogEntry): void {
    const modal = new SyncLogModal(this.app, entry, this.syncLogService);
    modal.open();
  }

  private async _restoreEntry(entry: SyncLogEntry): Promise<void> {
    const success = await this.syncLogService.restoreFromSnapshot(entry);
    if (success) {
      new Notice(t("log.restored", { path: entry.path }));
    } else {
      new Notice(t("log.restoreFailed", { path: entry.path }));
    }
  }

  private async _copyEntryContent(entry: SyncLogEntry): Promise<void> {
    const content = await this.syncLogService.readSnapshotContent(entry);
    if (content !== null) {
      await navigator.clipboard.writeText(content);
      new Notice(t("common.copied"));
    } else {
      new Notice(t("log.unreadable"));
    }
  }

  private _getIcon(type: SyncLogEntryType): string {
    switch (type) {
      case "remote-overwrite":
        return "download";
      case "remote-delete":
        return "trash";
      case "local-send":
        return "upload";
      case "initial-sync-receive":
        return "download-cloud";
      case "conflict-backup":
        return "shield";
    }
  }

  private _typeLabel(type: SyncLogEntryType): string {
    switch (type) {
      case "remote-overwrite":
        return t("log.type.remote-overwrite");
      case "remote-delete":
        return t("log.type.remote-delete");
      case "local-send":
        return t("log.type.local-send");
      case "initial-sync-receive":
        return t("log.type.initial-sync-receive");
      case "conflict-backup":
        return t("log.type.conflict-backup");
    }
  }
}
