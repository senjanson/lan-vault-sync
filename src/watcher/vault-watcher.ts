import {
  Editor,
  EventRef,
  MarkdownFileInfo,
  MarkdownView,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
  Workspace,
} from "obsidian";
import { FileChangeEvent, FolderChangeEvent } from "../types";
import { FileFilter } from "./file-filter";
import { DEBOUNCE_MS } from "../constants";
import { logger } from "../logger";

export type RemoteWriteKind = "write" | "delete" | "rename";

export class VaultWatcher {
  private filter: FileFilter;
  private eventRefs: EventRef[] = [];
  private workspaceRefs: EventRef[] = [];
  private changeCb: ((event: FileChangeEvent) => void) | null = null;
  private folderCb: ((event: FolderChangeEvent) => void) | null = null;
  private remoteWritePaths = new Map<string, number>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingModifyEvents = new Map<
    string,
    Pick<FileChangeEvent, "oldPath" | "content" | "source" | "savedToDisk">
  >();

  constructor(
    private vault: Vault,
    ignoredPaths: string[],
    private workspace?: Workspace,
    /** Sync only this folder (settings.syncFolder); "" for the whole vault. */
    syncFolder: string = "",
  ) {
    this.filter = new FileFilter(ignoredPaths, syncFolder);
  }

  updateIgnoredPaths(paths: string[]): void {
    this.filter.updateIgnoredPaths(paths);
  }

  onFileChanged(cb: (event: FileChangeEvent) => void): void {
    this.changeCb = cb;
  }

  onFolderChanged(cb: (event: FolderChangeEvent) => void): void {
    this.folderCb = cb;
  }

  /**
   * Mark a change this plugin is about to make for a peer, so the vault event
   * it causes is not sent back out. Only events of the same kind are skipped:
   * a user deleting or renaming a file right after a remote write is real.
   */
  markRemoteWrite(filePath: string, kind: RemoteWriteKind = "write"): void {
    const key = `${kind}\0${filePath}`;
    const expiresAt = Date.now() + 2000;
    this.remoteWritePaths.set(key, expiresAt);
    // Auto-clear after a generous window to ensure all editor/vault events fire
    setTimeout(() => {
      if (this.remoteWritePaths.get(key) === expiresAt) {
        this.remoteWritePaths.delete(key);
      }
    }, 2000);
  }

  hasPendingModify(filePath: string): boolean {
    return this.debounceTimers.has(filePath);
  }

  /**
   * Cancel a pending debounced modify event so the caller can ingest the latest
   * on-disk content immediately before applying a remote change.
   */
  consumePendingModify(filePath: string): boolean {
    return this.takePendingModify(filePath) !== null;
  }

  /**
   * Like consumePendingModify, but also returns the pending event's editor
   * content (when the change came from the editor and may not be saved yet),
   * and whether the file was saved to disk meanwhile.
   */
  takePendingModify(filePath: string): { content?: string; savedToDisk?: boolean } | null {
    const timer = this.debounceTimers.get(filePath);
    if (!timer) return null;

    clearTimeout(timer);
    this.debounceTimers.delete(filePath);
    const pending = this.pendingModifyEvents.get(filePath);
    this.pendingModifyEvents.delete(filePath);
    return { content: pending?.content, savedToDisk: pending?.savedToDisk };
  }

  start(): void {
    this.eventRefs.push(
      this.vault.on("create", (file) => this._onEvent("create", file)),
      this.vault.on("modify", (file) => this._onEvent("modify", file)),
      this.vault.on("delete", (file) => this._onEvent("delete", file)),
      this.vault.on("rename", (file, oldPath) =>
        this._onEvent("rename", file, oldPath),
      ),
    );

    if (this.workspace) {
      this.workspaceRefs.push(
        this.workspace.on(
          "editor-change",
          (editor: Editor, info: MarkdownView | MarkdownFileInfo) =>
            this._onEditorChange(editor, info),
        ),
      );
    }

    logger.info("Vault watcher started");
  }

  stop(): void {
    for (const ref of this.eventRefs) {
      this.vault.offref(ref);
    }
    this.eventRefs = [];
    // Workspace listeners are removed from the workspace they were added to.
    for (const ref of this.workspaceRefs) {
      this.workspace?.offref(ref);
    }
    this.workspaceRefs = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingModifyEvents.clear();
    logger.info("Vault watcher stopped");
  }

  private _onEvent(
    type: FileChangeEvent["type"],
    file: TAbstractFile,
    oldPath?: string,
  ): void {
    // A rename across the edge of what is synced (an ignored path, or the
    // folder this device syncs) is a deletion or a creation to peers: a
    // file moved out is gone for them, one moved in is new.
    if (type === "rename" && oldPath) {
      const newIgnored = this.filter.shouldIgnore(file.path);
      const oldIgnored = this.filter.shouldIgnore(oldPath);
      if (newIgnored && oldIgnored) return;
      if (newIgnored || oldIgnored) {
        // A rename this plugin made for a peer is not sent back out.
        if (this._isRemoteWrite(file.path, "rename")) return;
        if (newIgnored) {
          this._onMovedOut(file, oldPath);
        } else {
          this._onMovedIn(file);
        }
        return;
      }
    }

    if (file instanceof TFolder) {
      if (type === "modify" || file.isRoot()) return;
      if (this.filter.shouldIgnore(file.path)) return;
      if (this._isRemoteWrite(file.path, type)) return;
      this.folderCb?.({ type, path: file.path, oldPath });
      return;
    }
    if (!(file instanceof TFile)) return;

    const path = file.path;

    if (this.filter.shouldIgnore(path)) return;

    // Skip events caused by our own remote writes. Text modifications are
    // let through: the coordinator recognises its own writes by content, so
    // a real edit made right after a remote write is not lost.
    const isTextModify = type === "modify" && this.filter.isTextFile(path);
    if (!isTextModify && this._isRemoteWrite(path, type)) {
      logger.debug(`Skipping remote write event: ${path}`);
      // An edit still waiting under the old name now belongs to the new one.
      if (type === "rename" && oldPath) this._movePendingModify(oldPath, path);
      return;
    }

    // Deleted here: a file made again under this name, even at once and
    // with the same content, is the user's, not our remote write.
    if (type === "delete") this.remoteWritePaths.delete(`write\0${path}`);

    // Debounce modify events
    if (type === "modify") {
      this._queueModify(path, oldPath);
    } else if (type === "rename" && oldPath) {
      // An edit made just before the rename (a template or script often
      // does both at once) is still waiting under the old name, where the
      // file no longer is. It goes with the rename, so it is applied before
      // the rename is sent.
      const pending = this.takePendingModify(oldPath);
      this._emit(type, path, oldPath, pending?.content, "vault", pending?.savedToDisk, pending !== null);
    } else {
      this._emit(type, path, oldPath);
    }
  }

  /** A file or folder moved from a synced path to one that is not: deleted at its old path. */
  private _onMovedOut(file: TAbstractFile, oldPath: string): void {
    if (file instanceof TFolder) {
      if (!file.isRoot()) this.folderCb?.({ type: "delete", path: oldPath });
      return;
    }
    if (!(file instanceof TFile)) return;
    // An edit still waiting under the old name went out of sync with it.
    this.takePendingModify(oldPath);
    this.remoteWritePaths.delete(`write\0${oldPath}`);
    logger.debug(`Moved out of sync: ${oldPath} -> ${file.path}`);
    this._emit("delete", oldPath);
  }

  /** A file or folder moved from a path that is not synced to one that is: new at its path. */
  private _onMovedIn(file: TAbstractFile): void {
    if (file instanceof TFolder) {
      if (!file.isRoot()) this.folderCb?.({ type: "create", path: file.path });
      return;
    }
    if (!(file instanceof TFile)) return;
    logger.debug(`Moved into sync: ${file.path}`);
    this._emit("create", file.path);
  }

  private _movePendingModify(oldPath: string, newPath: string): void {
    const pending = this.takePendingModify(oldPath);
    if (!pending) return;
    this._queueModify(newPath, undefined, pending.content, typeof pending.content === "string" ? "editor" : "vault");
  }

  private _onEditorChange(
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ): void {
    const file = info.file;
    if (!(file instanceof TFile)) return;

    const path = file.path;
    if (this.filter.shouldIgnore(path) || !this.filter.isTextFile(path)) return;

    this._queueModify(path, undefined, editor.getValue(), "editor");
  }

  private _queueModify(
    path: string,
    oldPath?: string,
    content?: string,
    source: FileChangeEvent["source"] = "vault",
  ): void {
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);

    const pending = this.pendingModifyEvents.get(path);
    const nextContent =
      typeof content === "string" ? content : pending?.content;
    const nextSource =
      typeof content === "string" ? source : pending?.source ?? source;
    this.pendingModifyEvents.set(path, {
      oldPath: oldPath ?? pending?.oldPath,
      content: nextContent,
      source: nextSource,
      savedToDisk: typeof content !== "string" || pending?.savedToDisk,
    });

    this.debounceTimers.set(
      path,
      setTimeout(() => {
        this.debounceTimers.delete(path);
        const event = this.pendingModifyEvents.get(path);
        this.pendingModifyEvents.delete(path);
        this._emit(
          "modify",
          path,
          event?.oldPath,
          event?.content,
          event?.source ?? source,
          event?.savedToDisk,
        );
      }, DEBOUNCE_MS),
    );
  }

  private _isRemoteWrite(path: string, type: FileChangeEvent["type"]): boolean {
    const kind: RemoteWriteKind =
      type === "delete" ? "delete" : type === "rename" ? "rename" : "write";
    const key = `${kind}\0${path}`;
    const expiresAt = this.remoteWritePaths.get(key);
    if (!expiresAt) return false;

    if (expiresAt <= Date.now()) {
      this.remoteWritePaths.delete(key);
      return false;
    }

    return true;
  }

  private _emit(
    type: FileChangeEvent["type"],
    path: string,
    oldPath?: string,
    content?: string,
    source: FileChangeEvent["source"] = "vault",
    savedToDisk?: boolean,
    editedBeforeRename?: boolean,
  ): void {
    const event: FileChangeEvent = {
      type,
      path,
      oldPath,
      content,
      source,
      // Only tells something for a change taken from an editor.
      savedToDisk: typeof content === "string" ? savedToDisk : undefined,
      ...(editedBeforeRename ? { editedBeforeRename } : {}),
      isTextFile:
        type === "rename" && oldPath
          ? this.filter.isTextFile(path) || this.filter.isTextFile(oldPath)
          : this.filter.isTextFile(path),
      timestamp: Date.now(),
    };
    logger.debug(`File event: ${type} ${path}`);
    this.changeCb?.(event);
  }
}
