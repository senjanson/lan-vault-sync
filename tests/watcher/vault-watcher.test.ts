import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";

import { DEBOUNCE_MS } from "../../src/constants";
import { VaultWatcher } from "../../src/watcher/vault-watcher";
import type { FileChangeEvent, FolderChangeEvent } from "../../src/types";

type EventCallback = (...args: any[]) => void;

class FakeEventSource {
  private listeners = new Map<string, Set<EventCallback>>();

  on(name: string, callback: EventCallback): { name: string; callback: EventCallback } {
    const callbacks = this.listeners.get(name) ?? new Set<EventCallback>();
    callbacks.add(callback);
    this.listeners.set(name, callbacks);
    return { name, callback };
  }

  offref(ref: { name: string; callback: EventCallback }): void {
    this.listeners.get(ref.name)?.delete(ref.callback);
  }

  trigger(name: string, ...args: any[]): void {
    for (const callback of this.listeners.get(name) ?? []) {
      callback(...args);
    }
  }
}

class FakeVault extends FakeEventSource {}

class FakeWorkspace extends FakeEventSource {}

function createFile(path: string): TFile {
  return Object.assign(new TFile(), { path });
}

function createFolder(path: string): TFolder {
  return Object.assign(new TFolder(), { path });
}

describe("VaultWatcher", () => {
  let vault: FakeVault;
  let workspace: FakeWorkspace;
  let watcher: VaultWatcher;
  let events: FileChangeEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    vault = new FakeVault();
    workspace = new FakeWorkspace();
    watcher = new VaultWatcher(vault as any, [], workspace as any);
    events = [];
    watcher.onFileChanged((event) => events.push(event));
    watcher.start();
  });

  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
  });

  it("emits editor changes with the latest editor content", () => {
    const file = createFile("note.md");
    const editor = {
      getValue: () => "# edited on iphone",
    };

    workspace.trigger("editor-change", editor, { file });
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "modify",
      path: "note.md",
      content: "# edited on iphone",
      source: "editor",
      isTextFile: true,
    });
  });

  it("sends an edit still waiting under a file's old name along with its rename", () => {
    const file = createFile("old.md");
    vault.trigger("modify", file);
    file.path = "new.md";
    vault.trigger("rename", file, "old.md");
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "rename", path: "new.md", oldPath: "old.md", editedBeforeRename: true });
  });

  it("moves an edit waiting under a file's old name when the plugin renamed it", () => {
    const file = createFile("old.md");
    workspace.trigger("editor-change", { getValue: () => "typed" }, { file });
    watcher.markRemoteWrite("new.md", "rename");
    file.path = "new.md";
    vault.trigger("rename", file, "old.md");
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "modify", path: "new.md", content: "typed" });
  });

  it("keeps editor content when a vault modify event follows", () => {
    const file = createFile("note.md");
    const editor = {
      getValue: () => "newest content",
    };

    workspace.trigger("editor-change", editor, { file });
    vault.trigger("modify", file);
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "modify",
      path: "note.md",
      content: "newest content",
      source: "editor",
    });
  });

  it("lets text edits through after a remote write", () => {
    // The coordinator recognises echoes of its own writes by content, so a
    // real edit typed right after a remote write must still reach it.
    const file = createFile("note.md");
    const editor = {
      getValue: () => "typed after remote write",
    };

    watcher.markRemoteWrite("note.md");
    workspace.trigger("editor-change", editor, { file });
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("typed after remote write");
  });

  it("still suppresses non-text events for remote writes", () => {
    const file = createFile("image.png");

    watcher.markRemoteWrite("image.png");
    vault.trigger("modify", file);
    vault.trigger("create", file);
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(events).toHaveLength(0);
  });

  it("emits a user delete made right after a remote write", () => {
    const file = createFile("note.md");

    watcher.markRemoteWrite("note.md");
    vault.trigger("delete", file);
    watcher.markRemoteWrite("image.png", "delete");
    vault.trigger("delete", createFile("image.png"));

    expect(events.map((e) => [e.type, e.path])).toEqual([["delete", "note.md"]]);
  });
});

describe("VaultWatcher sync edge", () => {
  let vault: FakeVault;
  let events: FileChangeEvent[];
  let folders: FolderChangeEvent[];
  let watcher: VaultWatcher;

  function start(ignored: string[], syncFolder = ""): void {
    vault = new FakeVault();
    watcher = new VaultWatcher(vault as any, ignored, undefined, syncFolder);
    events = [];
    folders = [];
    watcher.onFileChanged((event) => events.push(event));
    watcher.onFolderChanged((event) => folders.push(event));
    watcher.start();
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
  });

  it("ignores files outside the synced folder", () => {
    start([], "Work");
    vault.trigger("create", createFile("Personal/a.md"));
    vault.trigger("modify", createFile("Workshop/b.md"));
    vault.trigger("create", createFolder("Personal"));
    vault.trigger("create", createFile("Work/c.md"));
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(events.map((e) => [e.type, e.path])).toEqual([["create", "Work/c.md"]]);
    expect(folders).toEqual([]);
  });

  it("takes a file moved out of the synced folder as deleted", () => {
    start([], "Work");
    const file = createFile("Work/a.md");
    vault.trigger("modify", file);
    file.path = "Personal/a.md";
    vault.trigger("rename", file, "Work/a.md");
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    // The edit waiting under the old name went out with the file.
    expect(events.map((e) => [e.type, e.path])).toEqual([["delete", "Work/a.md"]]);
    expect(events[0].isTextFile).toBe(true);
  });

  it("takes a file moved into the synced folder as new", () => {
    start([], "Work");
    const file = createFile("Work/img.png");
    vault.trigger("rename", file, "Personal/img.png");

    expect(events.map((e) => [e.type, e.path, e.oldPath])).toEqual([["create", "Work/img.png", undefined]]);
  });

  it("takes folders moved across the edge as deleted or new", () => {
    start([], "Work");
    const out = createFolder("Archive/Old");
    vault.trigger("rename", out, "Work/Old");
    const into = createFolder("Work/New");
    vault.trigger("rename", into, "Inbox/New");
    const outside = createFolder("Inbox/Moved");
    vault.trigger("rename", outside, "Inbox/Before");

    expect(folders).toEqual([
      { type: "delete", path: "Work/Old" },
      { type: "create", path: "Work/New" },
    ]);
  });

  it("applies the same to ignored paths", () => {
    start(["Private/"]);
    const a = createFile("Private/a.md");
    vault.trigger("rename", a, "Notes/a.md");
    const b = createFile("Notes/b.md");
    vault.trigger("rename", b, "Private/b.md");
    const c = createFile("Private/c.md");
    vault.trigger("rename", c, "Private/old-c.md");

    expect(events.map((e) => [e.type, e.path])).toEqual([
      ["delete", "Notes/a.md"],
      ["create", "Notes/b.md"],
    ]);
  });

  it("does not send back a rename across the edge made for a peer", () => {
    start(["Private/"]);
    watcher.markRemoteWrite("Private/a.md", "rename");
    vault.trigger("rename", createFile("Private/a.md"), "Notes/a.md");

    expect(events).toEqual([]);
  });

  it("syncs nothing for an invalid folder", () => {
    start([], "../x");
    vault.trigger("create", createFile("a.md"));
    vault.trigger("create", createFile("../x/a.md"));

    expect(events).toEqual([]);
  });

  it("keeps renames within the synced folder", () => {
    start([], "Work");
    const file = createFile("Work/b.md");
    vault.trigger("rename", file, "Work/a.md");

    expect(events.map((e) => [e.type, e.path, e.oldPath])).toEqual([["rename", "Work/b.md", "Work/a.md"]]);
  });
});

describe("VaultWatcher stop", () => {
  it("stops listening to editor changes", () => {
    vi.useFakeTimers();
    const vault = new FakeVault();
    const workspace = new FakeWorkspace();
    const watcher = new VaultWatcher(vault as any, [], workspace as any);
    const events: FileChangeEvent[] = [];
    watcher.onFileChanged((event) => events.push(event));
    watcher.start();
    watcher.stop();

    workspace.trigger("editor-change", { getValue: () => "x" }, { file: createFile("note.md") });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    vi.useRealTimers();

    expect(events).toHaveLength(0);
  });
});
