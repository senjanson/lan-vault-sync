import { describe, expect, it } from "vitest";
import { FileFilter } from "../../src/watcher/file-filter";

describe("FileFilter", () => {
  it("ignores nothing in the synced folder but its ignored paths", () => {
    const f = new FileFilter([".obsidian/", "Work/tmp"], "Work");
    expect(f.shouldIgnore("Work")).toBe(false);
    expect(f.shouldIgnore("Work/a.md")).toBe(false);
    expect(f.shouldIgnore("Work/sub/b.png")).toBe(false);
    expect(f.shouldIgnore("Work/tmp/c.md")).toBe(true);
    expect(f.shouldIgnore("Personal/a.md")).toBe(true);
    expect(f.shouldIgnore("Workshop/a.md")).toBe(true);
    expect(f.shouldIgnore("work/a.md")).toBe(true);
    expect(f.shouldIgnore("a.md")).toBe(true);
    expect(f.getScope()).toBe("Work");
  });

  it("takes the folder setting with surrounding slashes and space", () => {
    const f = new FileFilter([], " /Work/Sub/ ");
    expect(f.getScope()).toBe("Work/Sub");
    expect(f.shouldIgnore("Work/Sub/a.md")).toBe(false);
    expect(f.shouldIgnore("Work/a.md")).toBe(true);
  });

  it("syncs the whole vault without a folder", () => {
    const f = new FileFilter([".obsidian/"]);
    expect(f.getScope()).toBe("");
    expect(f.shouldIgnore("any/where.md")).toBe(false);
    expect(f.shouldIgnore(".obsidian/app.json")).toBe(true);
  });

  it("ignores everything for an invalid folder rather than nothing", () => {
    for (const bad of ["../Work", ".hidden", "a/../b", "C:/x", "a\\b"]) {
      const f = new FileFilter([], bad);
      expect(f.getScope()).toBeNull();
      expect(f.shouldIgnore("a.md")).toBe(true);
      expect(f.shouldIgnore(bad)).toBe(true);
    }
  });
});
