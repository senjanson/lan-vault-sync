/**
 * Recovery center: every version the version store kept, grouped by the
 * change that replaced it (a peer's batch, or a burst of one op), with a
 * way to look at each and put it back. It reads only the version store, not
 * the sync log, so it works even when the log was pruned or never written.
 */
import { App, ItemView, Modal, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { addStrings, t, formatDateTime } from "../i18n";
import type { HistoryVault, VersionEntry, VersionGroup, VersionStore } from "./version-store";
import { peerName } from "../diagnostics/health";

export const RECOVERY_VIEW_TYPE = "lan-vault-sync-recovery";

/** Entries drawn per group before "and N more", so a 600-file batch stays quick. */
const ENTRIES_PER_GROUP = 20;

addStrings("en", {
  "recovery.title": "Recovery center",
  "recovery.cmdOpen": "Open recovery center",
  "recovery.intro": "Versions kept before a sync deleted or replaced a file. Restoring keeps the current file first, so a restore can be undone too.",
  "recovery.search": "Filter by path",
  "recovery.refresh": "Refresh",
  "recovery.loading": "Loading…",
  "recovery.unavailable": "The version store is not ready yet. Turn sync on and try again.",
  "recovery.empty": "No versions kept yet.",
  "recovery.noMatch": "No kept version matches \"{query}\".",
  "recovery.thisDevice": "This device",
  "recovery.op.remote-file-delete": "deleted by another device",
  "recovery.op.remote-file-overwrite": "replaced by another device",
  "recovery.op.remote-file-rename-overwrite": "replaced by a renamed file",
  "recovery.op.follow-rename": "renamed by another device",
  "recovery.op.text-merge": "merged with another device's edits",
  "recovery.op.text-remote-overwrite": "replaced by another device",
  "recovery.op.merge-write": "merged with another device's edits",
  "recovery.op.shrink": "emptied or cut short by another device",
  "recovery.op.before-restore": "before a restore",
  "recovery.op.restore": "before a restore",
  "recovery.groupHeading": "{peer} · {time} · {count} file(s) · {ops}",
  "recovery.batch": "Batch {batch}",
  "recovery.more": "…and {count} more",
  "recovery.view": "View",
  "recovery.restore": "Restore",
  "recovery.restoreAll": "Restore all",
  "recovery.restored": "LAN Sync: restored {path}",
  "recovery.restoreFailed": "LAN Sync: could not restore {path}. The current file was left as it is.",
  "recovery.restoredAll": "LAN Sync: restored {count} file(s)",
  "recovery.restoredSome": "LAN Sync: restored {count} file(s); {failed} could not be restored and were left as they are.",
  "recovery.binary": "Not text: {size}, SHA-256 {hash}",
  "recovery.missing": "The kept content is missing (hash {hash}).",
});

addStrings("zh", {
  "recovery.title": "恢复中心",
  "recovery.cmdOpen": "打开恢复中心",
  "recovery.intro": "同步删除或替换文件之前保留的旧版本。恢复时会先保留当前文件，所以恢复本身也可以撤销。",
  "recovery.search": "按路径筛选",
  "recovery.refresh": "刷新",
  "recovery.loading": "正在加载…",
  "recovery.unavailable": "版本库尚未就绪。请先开启同步，然后再试。",
  "recovery.empty": "还没有保留任何版本。",
  "recovery.noMatch": "没有与“{query}”匹配的版本。",
  "recovery.thisDevice": "本设备",
  "recovery.op.remote-file-delete": "被其他设备删除",
  "recovery.op.remote-file-overwrite": "被其他设备替换",
  "recovery.op.remote-file-rename-overwrite": "被改名的文件替换",
  "recovery.op.follow-rename": "被其他设备改名",
  "recovery.op.text-merge": "与其他设备的修改合并",
  "recovery.op.text-remote-overwrite": "被其他设备替换",
  "recovery.op.merge-write": "与其他设备的修改合并",
  "recovery.op.shrink": "被其他设备清空或删掉大半",
  "recovery.op.before-restore": "恢复前的版本",
  "recovery.op.restore": "恢复前的版本",
  "recovery.groupHeading": "{peer} · {time} · {count} 个文件 · {ops}",
  "recovery.batch": "批次 {batch}",
  "recovery.more": "……还有 {count} 个",
  "recovery.view": "查看",
  "recovery.restore": "恢复",
  "recovery.restoreAll": "全部恢复",
  "recovery.restored": "LAN Sync：已恢复 {path}",
  "recovery.restoreFailed": "LAN Sync：无法恢复 {path}，当前文件保持不变。",
  "recovery.restoredAll": "LAN Sync：已恢复 {count} 个文件",
  "recovery.restoredSome": "LAN Sync：已恢复 {count} 个文件；{failed} 个无法恢复，保持不变。",
  "recovery.binary": "非文本内容：{size}，SHA-256 {hash}",
  "recovery.missing": "保留的内容已丢失（哈希 {hash}）。",
});

/** What replaced a version, in the user's words; the step's name when there are none. */
function opLabel(op: string): string {
  const key = `recovery.op.${op}`;
  const text = t(key);
  return text === key ? op : text;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  return formatDateTime(ts);
}

/** The store may come later than the view (the workspace restores views at startup). */
export type StoreSource = VersionStore | null | (() => VersionStore | null);

export class RecoveryView extends ItemView {
  private groups: VersionGroup[] | null = null;
  private query = "";
  private busy = false;

  constructor(
    leaf: WorkspaceLeaf,
    private source: StoreSource,
    private vault?: HistoryVault,
  ) {
    super(leaf);
  }

  private get store(): VersionStore | null {
    return typeof this.source === "function" ? this.source() : this.source;
  }

  getViewType(): string {
    return RECOVERY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("recovery.title");
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    await this.reload();
  }

  /** Reads the groups again from the store and redraws. */
  async reload(): Promise<void> {
    this.groups = null;
    this.render();
    const store = this.store;
    if (store) {
      try {
        this.groups = await store.groups();
      } catch {
        this.groups = [];
      }
    }
    this.render();
  }

  /** Groups with only the entries that match the search, empty ones left out. */
  private visibleGroups(): VersionGroup[] {
    const q = this.query.trim().toLowerCase();
    if (!this.groups) return [];
    if (!q) return this.groups;
    return this.groups
      .map((g) => ({ ...g, entries: g.entries.filter((e) => e.path.toLowerCase().includes(q)) }))
      .filter((g) => g.entries.length > 0);
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    container.empty();
    container.createEl("h4", { text: t("recovery.title") });
    container.createEl("p", { text: t("recovery.intro"), cls: "lan-sync-muted" });

    const bar = container.createDiv({ cls: "lan-sync-recovery-bar" });
    const search = bar.createEl("input", {
      type: "search",
      placeholder: t("recovery.search"),
      value: this.query,
    }) as HTMLInputElement;
    search.oninput = () => {
      this.query = search.value ?? "";
      this.renderList(list);
    };
    const refresh = bar.createEl("button", { text: t("recovery.refresh") });
    refresh.onclick = () => void this.reload();

    const list = container.createDiv({ cls: "lan-sync-recovery-list" });
    this.renderList(list);
  }

  private renderList(list: HTMLElement): void {
    list.empty();
    if (!this.store) {
      list.createEl("p", { text: t("recovery.unavailable"), cls: "lan-sync-muted" });
      return;
    }
    if (this.groups === null) {
      list.createEl("p", { text: t("recovery.loading"), cls: "lan-sync-muted" });
      return;
    }
    const groups = this.visibleGroups();
    if (groups.length === 0) {
      list.createEl("p", {
        text: this.query.trim() ? t("recovery.noMatch", { query: this.query.trim() }) : t("recovery.empty"),
        cls: "lan-sync-muted",
      });
      return;
    }
    for (const g of groups) this.renderGroup(list, g);
  }

  private renderGroup(list: HTMLElement, g: VersionGroup): void {
    const box = list.createDiv({ cls: "lan-sync-section lan-sync-recovery-group" });
    const head = box.createDiv({ cls: "lan-sync-recovery-group-head" });
    head.createEl("strong", {
      text: t("recovery.groupHeading", {
        peer: g.peer ? peerName(g.peer) : t("recovery.thisDevice"),
        time: formatTime(g.from) === formatTime(g.to) ? formatTime(g.to) : `${formatTime(g.from)} – ${formatTime(g.to)}`,
        count: g.entries.length,
        ops: g.ops.map(opLabel).join(", "),
      }),
    });
    if (g.batch) head.createEl("div", { text: t("recovery.batch", { batch: g.batch }), cls: "lan-sync-muted" });
    // With a search, "Restore all" restores what the group shows: the matches.
    const all = head.createEl("button", { text: t("recovery.restoreAll"), cls: "mod-cta" });
    all.onclick = () => void this.restoreAll(g.entries, all);

    const ul = box.createEl("ul", { cls: "lan-sync-recovery-entries" });
    for (const e of g.entries.slice(0, ENTRIES_PER_GROUP)) this.renderEntry(ul, e);
    if (g.entries.length > ENTRIES_PER_GROUP) {
      ul.createEl("li", { text: t("recovery.more", { count: g.entries.length - ENTRIES_PER_GROUP }), cls: "lan-sync-muted" });
    }
  }

  private renderEntry(ul: HTMLElement, e: VersionEntry): void {
    const li = ul.createEl("li", { cls: "lan-sync-recovery-entry" });
    li.createSpan({ text: e.path, cls: "lan-sync-recovery-path" });
    li.createSpan({
      text: ` · ${formatTime(e.ts)} · ${formatBytes(e.size)} · ${opLabel(e.op)}`,
      cls: "lan-sync-muted",
    });
    const actions = li.createDiv({ cls: "lan-sync-recovery-actions" });
    const view = actions.createEl("button", { text: t("recovery.view") });
    view.onclick = () => {
      const store = this.store;
      if (store) new VersionModal(this.app, store, e).open();
    };
    const restore = actions.createEl("button", { text: t("recovery.restore") });
    restore.onclick = () => void this.restoreOne(e, restore);
  }

  private async restoreOne(e: VersionEntry, button: HTMLButtonElement): Promise<void> {
    const store = this.store;
    if (!store || this.busy) return;
    this.busy = true;
    button.disabled = true;
    try {
      const ok = await store.restore(e, this.vault);
      new Notice(t(ok ? "recovery.restored" : "recovery.restoreFailed", { path: e.path }));
    } finally {
      this.busy = false;
    }
    await this.reload();
  }

  private async restoreAll(entries: VersionEntry[], button: HTMLButtonElement): Promise<void> {
    const store = this.store;
    if (!store || this.busy) return;
    this.busy = true;
    button.disabled = true;
    try {
      const { restored, failed } = await store.restoreGroup(entries, this.vault);
      new Notice(
        failed.length === 0
          ? t("recovery.restoredAll", { count: restored.length })
          : t("recovery.restoredSome", { count: restored.length, failed: failed.length }),
      );
    } finally {
      this.busy = false;
    }
    await this.reload();
  }
}

/** Shows a kept version: its text, or its size and hash when it is not text. */
export class VersionModal extends Modal {
  constructor(
    app: App,
    private store: VersionStore,
    private entry: VersionEntry,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    this.titleEl?.setText?.(this.entry.path);
    contentEl.empty?.();
    const data = await this.store.read(this.entry.hash);
    if (!data) {
      contentEl.createEl("p", { text: t("recovery.missing", { hash: this.entry.hash }) });
      return;
    }
    const text = decodeUtf8(data);
    if (text === null) {
      contentEl.createEl("p", {
        text: t("recovery.binary", { size: formatBytes(data.byteLength), hash: this.entry.hash }),
      });
      return;
    }
    const pre = contentEl.createEl("pre", { cls: "lan-sync-recovery-text" });
    pre.createEl("code", { text });
  }

  onClose(): void {
    this.contentEl.empty?.();
  }
}

/** The text, or null when the bytes are not valid UTF-8. */
export function decodeUtf8(data: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/**
 * Registers the view and the "Open recovery center" command. The store is
 * looked up when used, since it is made after the plugin loads.
 */
export function registerRecoveryCenter(plugin: Plugin, getStore: () => VersionStore | null): void {
  const vault = plugin.app.vault;
  plugin.registerView(RECOVERY_VIEW_TYPE, (leaf: WorkspaceLeaf) => new RecoveryView(leaf, getStore, vault));
  plugin.addCommand({
    id: "open-recovery-center",
    name: t("recovery.cmdOpen"),
    callback: () => void openRecoveryCenter(plugin),
  });
}

/** Opens the recovery center in a main tab, or shows the one already open. */
export async function openRecoveryCenter(plugin: Plugin): Promise<void> {
  const { workspace } = plugin.app;
  let leaf = workspace.getLeavesOfType(RECOVERY_VIEW_TYPE)[0];
  if (!leaf) {
    leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: RECOVERY_VIEW_TYPE, active: true });
  }
  workspace.revealLeaf(leaf);
}
