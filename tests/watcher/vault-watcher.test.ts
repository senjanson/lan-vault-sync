import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";

import { DEBOUNCE_MS } from "../../src/constants";
import { VaultWatcher } from "../../src/watcher/vault-watcher";
import type { FileChangeEvent } from "../../src/types";

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

  it("suppresses both editor and vault events for remote writes", () => {
    const file = createFile("note.md");
    const editor = {
      getValue: () => "remote content",
    };

    watcher.markRemoteWrite("note.md");
    workspace.trigger("editor-change", editor, { file });
    vault.trigger("modify", file);
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(events).toHaveLength(0);
  });
});
