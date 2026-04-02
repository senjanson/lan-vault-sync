import {
  Editor,
  EventRef,
  MarkdownFileInfo,
  MarkdownView,
  TAbstractFile,
  TFile,
  Vault,
  Workspace,
} from "obsidian";
import { FileChangeEvent } from "../types";
import { FileFilter } from "./file-filter";
import { DEBOUNCE_MS } from "../constants";
import { logger } from "../logger";

export class VaultWatcher {
  private filter: FileFilter;
  private eventRefs: EventRef[] = [];
  private changeCb: ((event: FileChangeEvent) => void) | null = null;
  private remoteWritePaths = new Map<string, number>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingModifyEvents = new Map<
    string,
    Pick<FileChangeEvent, "oldPath" | "content" | "source">
  >();

  constructor(
    private vault: Vault,
    ignoredPaths: string[],
    private workspace?: Workspace,
  ) {
    this.filter = new FileFilter(ignoredPaths);
  }

  updateIgnoredPaths(paths: string[]): void {
    this.filter.updateIgnoredPaths(paths);
  }

  onFileChanged(cb: (event: FileChangeEvent) => void): void {
    this.changeCb = cb;
  }

  /** Mark a path as coming from a remote write — next change will be ignored */
  markRemoteWrite(filePath: string): void {
    const expiresAt = Date.now() + 2000;
    this.remoteWritePaths.set(filePath, expiresAt);
    // Auto-clear after a generous window to ensure all editor/vault events fire
    setTimeout(() => {
      if (this.remoteWritePaths.get(filePath) === expiresAt) {
        this.remoteWritePaths.delete(filePath);
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
    const timer = this.debounceTimers.get(filePath);
    if (!timer) return false;

    clearTimeout(timer);
    this.debounceTimers.delete(filePath);
    return true;
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
      this.eventRefs.push(
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
    if (!(file instanceof TFile)) return;

    const path = file.path;

    if (this.filter.shouldIgnore(path)) return;
    if (oldPath && this.filter.shouldIgnore(oldPath)) return;

    // Check if this is a remote write
    if (this._isRemoteWrite(path)) {
      logger.debug(`Skipping remote write event: ${path}`);
      return;
    }

    // Debounce modify events
    if (type === "modify") {
      this._queueModify(path, oldPath);
    } else {
      this._emit(type, path, oldPath);
    }
  }

  private _onEditorChange(
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ): void {
    const file = info.file;
    if (!(file instanceof TFile)) return;

    const path = file.path;
    if (this.filter.shouldIgnore(path) || !this.filter.isTextFile(path)) return;

    if (this._isRemoteWrite(path)) {
      logger.debug(`Skipping remote editor change: ${path}`);
      return;
    }

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
        );
      }, DEBOUNCE_MS),
    );
  }

  private _isRemoteWrite(path: string): boolean {
    const expiresAt = this.remoteWritePaths.get(path);
    if (!expiresAt) return false;

    if (expiresAt <= Date.now()) {
      this.remoteWritePaths.delete(path);
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
  ): void {
    const event: FileChangeEvent = {
      type,
      path,
      oldPath,
      content,
      source,
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
