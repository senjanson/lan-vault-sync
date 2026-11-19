/**
 * Version store: the old version of every file a peer deletes or
 * overwrites, kept in the vault so that it can be found and put back.
 *
 *   .lan-vault-sync/history/blobs/<first 2 hex>/<sha256>.bin
 *   .lan-vault-sync/history/index/YYYY-MM-DD.jsonl
 *
 * Content is stored by its hash, so a file kept many times (or 600 copies of
 * one template) takes the space of one. The index has one JSON line per kept
 * version; lines are buffered briefly and appended together, like the sync
 * log, because a bulk delete keeps a version of every file.
 *
 * The folder starts with a dot, so the sync code never sends it to peers.
 */
import type { TAbstractFile, TFile } from "obsidian";
import { computeFileHash } from "../binary-sync/file-hash";
import { CONFLICT_BACKUP_DIR } from "../constants";
import { DATA_DIR } from "../diagnostics/event-log";
import { logger } from "../logger";
import type { OpContext, VersionKeeper } from "../sync/apply-gate";
import { ensureDirectory, ensureVaultParentFolder } from "../utils/path-utils";

export const HISTORY_DIR = `${DATA_DIR}/history`;
export const BLOB_DIR = `${HISTORY_DIR}/blobs`;
export const INDEX_DIR = `${HISTORY_DIR}/index`;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A note merged often keeps at most one version per this long. */
export const NOTE_KEEP_INTERVAL_MS = 5 * MINUTE_MS;
/** Changes from one peer with one op this close together form one group. */
export const GROUP_GAP_MS = 2 * MINUTE_MS;

/** One kept version: one line of the index. */
export interface VersionEntry {
  ts: number;
  path: string;
  /** SHA-256 of the content; also the blob's name. */
  hash: string;
  size: number;
  /** Why it was kept: "delete", "overwrite", "merge-write", "before-restore"... */
  op: string;
  /** Peer as "deviceId (name)". */
  peer?: string;
  batch?: string;
  rule?: string;
}

/** Versions changed together: one batch, or one peer's burst of one op. */
export interface VersionGroup {
  key: string;
  peer?: string;
  batch?: string;
  /** The ops in the group, most common first. */
  ops: string[];
  /** Oldest and newest entry times. */
  from: number;
  to: number;
  /** Newest first. */
  entries: VersionEntry[];
}

export interface ListOptions {
  sinceTs?: number;
  path?: string;
  limit?: number;
}

export interface PruneOptions {
  keepDays?: number;
  maxBytes?: number;
}

export interface PruneResult {
  removedVersions: number;
  removedBlobs: number;
  freedBytes: number;
  removedConflictBackups: number;
}

export interface NoteWriteResult {
  kept: boolean;
  /** The note lost all or more than half its text: the caller raises an alert. */
  shrink: boolean;
  id?: string;
}

/** The part of Obsidian's DataAdapter the store needs. */
export interface HistoryAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  append?(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir?(path: string, recursive: boolean): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat?(path: string): Promise<{ size: number } | null>;
}

/** The part of Obsidian's Vault a restore needs. */
export interface HistoryVault {
  getAbstractFileByPath(path: string): TAbstractFile | null;
  readBinary(file: TFile): Promise<ArrayBuffer>;
  createBinary(path: string, data: ArrayBuffer): Promise<TFile>;
  modifyBinary(file: TFile, data: ArrayBuffer): Promise<void>;
}

export interface VersionStoreOptions {
  now?: () => number;
  flushMs?: number;
}

function dayOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/** Adapters list either full paths or bare names; make them full. */
function fullPath(dir: string, name: string): string {
  return name.includes("/") ? name : `${dir}/${name}`;
}

function isFolder(f: TAbstractFile | null): boolean {
  return !!f && Array.isArray((f as { children?: unknown }).children);
}

const HASH_RE = /^[0-9a-f]{64}$/;

export function blobPath(hash: string): string {
  return `${BLOB_DIR}/${hash.slice(0, 2)}/${hash}.bin`;
}

export class VersionStore implements VersionKeeper {
  private buffer: VersionEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Index writes and rewrites run one after another, so prune loses no line. */
  private writing: Promise<void> = Promise.resolve();
  /** Blob writes and blob removal run one after another; see prune. */
  private blobLock: Promise<unknown> = Promise.resolve();
  private madeDirs = new Set<string>();
  /** Blobs known to be on disk, so a repeat keep skips the lookup. */
  private knownBlobs = new Set<string>();
  /** When each note last had a merge write kept; see keepNoteWrite. */
  private lastNoteKeep = new Map<string, number>();
  /** Total blob bytes once usage() has counted them, kept up to date after. */
  private bytesCache: number | null = null;
  private readonly flushMs: number;
  private readonly now: () => number;
  lastWriteError: string | null = null;

  constructor(
    private adapter: HistoryAdapter,
    private vault?: HistoryVault,
    options: VersionStoreOptions = {},
  ) {
    this.flushMs = options.flushMs ?? 1000;
    this.now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------------- keeping

  /**
   * Keeps a version. Never throws: null tells the caller the version is not
   * safe, and the caller then refuses the change.
   */
  async keep(
    path: string,
    content: Uint8Array,
    reason: string,
    ctx: OpContext,
  ): Promise<{ id: string; hash: string } | null> {
    try {
      const hash = await computeFileHash(toArrayBuffer(content));
      await this.exclusive(() => this.writeBlob(hash, content));
      const entry: VersionEntry = {
        ts: this.now(),
        path,
        hash,
        size: content.byteLength,
        op: reason,
        peer: ctx.peer,
        batch: ctx.batch,
        rule: ctx.rule,
      };
      for (const key of Object.keys(entry) as Array<keyof VersionEntry>) {
        if (entry[key] === undefined) delete entry[key];
      }
      this.enqueue(entry);
      return { id: hash, hash };
    } catch (err) {
      logger.debug(`Keeping a version of ${path} failed:`, err);
      return null;
    }
  }

  keepText(path: string, text: string, reason: string, ctx: OpContext) {
    return this.keep(path, new TextEncoder().encode(text), reason, ctx);
  }

  /**
   * Keeps the old text of a note a merge is about to rewrite. Merges come
   * often, so a note keeps at most one version per 5 minutes; but a write
   * that empties the note or cuts it below half is kept at once, since that
   * is how lost text looks.
   */
  async keepNoteWrite(
    path: string,
    oldText: string,
    newText: string,
    ctx: OpContext,
  ): Promise<NoteWriteResult> {
    if (!oldText || oldText === newText) return { kept: false, shrink: false };
    const shrink = newText.length === 0 || newText.length < oldText.length / 2;
    const last = this.lastNoteKeep.get(path);
    const now = this.now();
    if (!shrink && last !== undefined && now - last < NOTE_KEEP_INTERVAL_MS) {
      return { kept: false, shrink };
    }
    const kept = await this.keepText(path, oldText, shrink ? "shrink" : "merge-write", ctx);
    if (!kept) return { kept: false, shrink };
    this.lastNoteKeep.set(path, now);
    return { kept: true, shrink, id: kept.id };
  }

  private async writeBlob(hash: string, content: Uint8Array): Promise<void> {
    if (this.knownBlobs.has(hash)) return;
    const file = blobPath(hash);
    const dir = file.slice(0, file.lastIndexOf("/"));
    // Blobs are named by their content, so writing one that is already
    // there changes nothing; skipping the exists check saves a call per
    // kept file, which adds up when a peer deletes hundreds of files.
    if (!this.madeDirs.has(dir)) await this.ensureDir(dir);
    try {
      await this.adapter.writeBinary(file, toArrayBuffer(content));
    } catch {
      // The folder may have been removed since we made it.
      this.madeDirs.delete(dir);
      await this.ensureDir(dir);
      await this.adapter.writeBinary(file, toArrayBuffer(content));
    }
    if (this.bytesCache !== null) this.bytesCache += content.byteLength;
    this.knownBlobs.add(hash);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.blobLock.then(fn, fn);
    this.blobLock = run.catch(() => undefined);
    return run;
  }

  private enqueue(entry: VersionEntry): void {
    this.buffer.push(entry);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushMs);
    }
  }

  /** Writes the buffered index lines. Safe to call often. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.serial(() => this.writeIndex());
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    this.writing = this.writing.then(fn, fn);
    return this.writing;
  }

  private async writeIndex(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const byDay = new Map<string, string>();
    for (const e of batch) {
      const file = `${INDEX_DIR}/${dayOf(e.ts)}.jsonl`;
      byDay.set(file, (byDay.get(file) ?? "") + JSON.stringify(e) + "\n");
    }
    try {
      await this.ensureDir(INDEX_DIR);
      for (const [file, text] of byDay) {
        if (this.adapter.append) {
          await this.adapter.append(file, text);
        } else {
          const old = (await this.adapter.exists(file)) ? await this.adapter.read(file) : "";
          await this.adapter.write(file, old + text);
        }
      }
      this.lastWriteError = null;
    } catch (e) {
      // The blobs are on disk; keep the lines for the next try.
      this.buffer = batch.concat(this.buffer);
      const msg = e instanceof Error ? e.message : String(e);
      if (this.lastWriteError !== msg) console.error("[LAN-Vault-Sync] cannot write version index:", msg);
      this.lastWriteError = msg;
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.madeDirs.has(dir)) return;
    const parent = dir.slice(0, Math.max(0, dir.lastIndexOf("/")));
    if (parent && this.madeDirs.has(parent)) {
      // Parent is known to exist: one mkdir, and a check only if it fails.
      try {
        await this.adapter.mkdir(dir);
      } catch (err) {
        if (!(await this.adapter.exists(dir))) throw err;
      }
    } else {
      await ensureDirectory(this.adapter, dir);
      for (let d = parent; d; d = d.slice(0, Math.max(0, d.lastIndexOf("/")))) this.madeDirs.add(d);
    }
    this.madeDirs.add(dir);
  }

  // ---------------------------------------------------------------- reading

  private async indexFiles(): Promise<string[]> {
    if (!(await this.adapter.exists(INDEX_DIR))) return [];
    const { files } = await this.adapter.list(INDEX_DIR);
    return files
      .map((f) => fullPath(INDEX_DIR, f))
      .filter((f) => /\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  }

  private parse(text: string): VersionEntry[] {
    const out: VersionEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as VersionEntry;
        if (e && typeof e.path === "string" && typeof e.hash === "string") out.push(e);
      } catch {
        /* a line cut short by a crash */
      }
    }
    return out;
  }

  /** Index entries on disk and still buffered, oldest first. */
  private async readEntries(sinceTs?: number): Promise<VersionEntry[]> {
    const out: VersionEntry[] = [];
    const sinceDay = sinceTs !== undefined ? dayOf(sinceTs) : "";
    for (const file of await this.indexFiles()) {
      if (sinceDay && file.slice(-16, -6) < sinceDay) continue;
      out.push(...this.parse(await this.adapter.read(file).catch(() => "")));
    }
    out.push(...this.buffer);
    return out;
  }

  /** Kept versions, newest first. */
  async list(options: ListOptions = {}): Promise<VersionEntry[]> {
    const { sinceTs, path, limit } = options;
    let entries = await this.readEntries(sinceTs);
    entries = entries.filter(
      (e) => (sinceTs === undefined || e.ts >= sinceTs) && (path === undefined || e.path === path),
    );
    // Stable sort by time, then newest first; equal times keep write order reversed.
    const sorted = entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => b.e.ts - a.e.ts || b.i - a.i)
      .map((x) => x.e);
    return limit !== undefined ? sorted.slice(0, limit) : sorted;
  }

  /** A kept version's content, or null when it is missing. */
  async read(hash: string): Promise<Uint8Array | null> {
    if (!HASH_RE.test(hash)) return null;
    try {
      return new Uint8Array(await this.adapter.readBinary(blobPath(hash)));
    } catch {
      return null;
    }
  }

  /**
   * Groups versions changed together, newest group first: by batch when the
   * change had one, else by peer and op with no gap over 2 minutes. A bulk
   * delete then shows (and is restored) as one thing.
   */
  async groups(options: ListOptions = {}): Promise<VersionGroup[]> {
    return groupEntries(await this.list(options));
  }

  // -------------------------------------------------------------- restoring

  /**
   * Puts a version back at its path. The file there now is kept first
   * ("before-restore"), so a restore can itself be undone; when that fails,
   * nothing is written and false is returned.
   */
  async restore(entry: VersionEntry, vault: HistoryVault | undefined = this.vault): Promise<boolean> {
    if (!vault) return false;
    try {
      const data = await this.read(entry.hash);
      if (!data) return false;
      const existing = vault.getAbstractFileByPath(entry.path);
      if (isFolder(existing)) return false;
      if (existing) {
        const file = existing as TFile;
        const current = new Uint8Array(await vault.readBinary(file));
        if ((await computeFileHash(toArrayBuffer(current))) === entry.hash) return true;
        const kept = await this.keep(entry.path, current, "before-restore", { rule: "restore" });
        if (!kept) return false;
        await vault.modifyBinary(file, toArrayBuffer(data));
      } else {
        await ensureVaultParentFolder(
          { adapter: this.adapter, getAbstractFileByPath: (p) => vault.getAbstractFileByPath(p) },
          entry.path,
        );
        await vault.createBinary(entry.path, toArrayBuffer(data));
      }
      return true;
    } catch (err) {
      logger.error(`Restoring ${entry.path} failed:`, err);
      return false;
    }
  }

  /** Restores the newest version of each path in the group. */
  async restoreGroup(
    entries: VersionEntry[],
    vault: HistoryVault | undefined = this.vault,
  ): Promise<{ restored: string[]; failed: string[] }> {
    const newest = new Map<string, VersionEntry>();
    for (const e of entries) {
      const seen = newest.get(e.path);
      if (!seen || e.ts > seen.ts) newest.set(e.path, e);
    }
    const restored: string[] = [];
    const failed: string[] = [];
    for (const e of newest.values()) {
      if (await this.restore(e, vault)) restored.push(e.path);
      else failed.push(e.path);
    }
    await this.flush();
    return { restored, failed };
  }

  // -------------------------------------------------------------- retention

  /** Blob sizes by hash. */
  private async blobSizes(): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    if (!(await this.adapter.exists(BLOB_DIR))) return sizes;
    const { folders } = await this.adapter.list(BLOB_DIR);
    for (const folder of folders.map((f) => fullPath(BLOB_DIR, f))) {
      const { files } = await this.adapter.list(folder).catch(() => ({ files: [] as string[] }));
      for (const file of files.map((f) => fullPath(folder, f))) {
        const m = /([0-9a-f]{64})\.bin$/.exec(file);
        if (m) sizes.set(m[1], await this.size(file));
      }
    }
    return sizes;
  }

  private async size(file: string): Promise<number> {
    if (this.adapter.stat) {
      const st = await this.adapter.stat(file).catch(() => null);
      if (st) return st.size;
    }
    const data = await this.adapter.readBinary(file).catch(() => null);
    return data ? data.byteLength : 0;
  }

  /** Bytes the blobs take, and how many versions the index holds. */
  async usage(): Promise<{ bytes: number; versions: number }> {
    const versions = (await this.readEntries()).length;
    if (this.bytesCache === null) {
      let bytes = 0;
      for (const s of (await this.blobSizes()).values()) bytes += s;
      this.bytesCache = bytes;
    }
    return { bytes: this.bytesCache, versions };
  }

  /** Whether the store is over 90% of its cap, for an alert. */
  async nearCap(maxBytes: number): Promise<boolean> {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return false;
    return (await this.usage()).bytes > 0.9 * maxBytes;
  }

  /**
   * Drops versions older than keepDays, then the oldest until the blobs fit
   * maxBytes, then the blobs no version refers to. Index lines go first and
   * blobs second, so a crash in between leaves stray blobs, never lines that
   * point at nothing. Today's versions are never dropped for size: they are
   * what a user looks for after a bad sync.
   */
  async prune(options: PruneOptions = {}): Promise<PruneResult> {
    const keepDays = options.keepDays ?? 30;
    const maxBytes = options.maxBytes ?? Infinity;
    const result: PruneResult = { removedVersions: 0, removedBlobs: 0, freedBytes: 0, removedConflictBackups: 0 };
    await this.flush();
    // Lines that could not be written yet would be missed as references.
    if (this.buffer.length > 0) return result;

    const cutoff = this.now() - keepDays * DAY_MS;
    const today = dayOf(this.now());
    const sizes = await this.blobSizes();

    // Index phase: decide what stays and rewrite the day files, in the index
    // write queue so that no append lands between the read and the rewrite.
    await this.serial(async () => {
      const files: Array<{ file: string; entries: VersionEntry[]; changed: boolean }> = [];
      for (const file of await this.indexFiles()) {
        const text = await this.adapter.read(file).catch(() => null);
        if (text === null) continue;
        const all = this.parse(text);
        const keep = all.filter((e) => e.ts >= cutoff);
        const lines = text.split("\n").filter((l) => l.trim()).length;
        files.push({ file, entries: keep, changed: keep.length !== lines });
        result.removedVersions += all.length - keep.length;
      }

      if (Number.isFinite(maxBytes)) {
        const refs = new Map<string, number>();
        for (const f of files) for (const e of f.entries) refs.set(e.hash, (refs.get(e.hash) ?? 0) + 1);
        let total = 0;
        for (const [hash, size] of sizes) if (refs.has(hash)) total += size;
        const candidates = files
          .filter((f) => f.file.slice(-16, -6) !== today)
          .flatMap((f) => f.entries.map((e) => ({ f, e })))
          .sort((a, b) => a.e.ts - b.e.ts);
        for (const { f, e } of candidates) {
          if (total <= maxBytes) break;
          f.entries.splice(f.entries.indexOf(e), 1);
          f.changed = true;
          result.removedVersions += 1;
          const left = (refs.get(e.hash) ?? 1) - 1;
          refs.set(e.hash, left);
          if (left === 0) {
            refs.delete(e.hash);
            total -= sizes.get(e.hash) ?? 0;
          }
        }
      }

      for (const f of files) {
        if (!f.changed) continue;
        try {
          if (f.entries.length === 0) await this.adapter.remove(f.file);
          else await this.adapter.write(f.file, f.entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
        } catch (err) {
          logger.debug(`Pruning ${f.file} failed:`, err);
        }
      }
    });

    // Blob phase: what the index no longer names. Run in the blob queue, so a
    // keep() of the same content cannot find the blob and then lose it.
    await this.exclusive(async () => {
      const referenced = new Set((await this.readEntries()).map((e) => e.hash));
      for (const [hash, size] of sizes) {
        if (referenced.has(hash)) continue;
        try {
          await this.adapter.remove(blobPath(hash));
          this.knownBlobs.delete(hash);
          result.removedBlobs += 1;
          result.freedBytes += size;
        } catch (err) {
          logger.debug(`Removing version blob ${hash} failed:`, err);
        }
      }
    });
    this.bytesCache = null;
    for (const [path, ts] of this.lastNoteKeep) if (ts < cutoff) this.lastNoteKeep.delete(path);

    result.removedConflictBackups = await this.pruneConflictBackups(cutoff);
    return result;
  }

  /**
   * The conflict backups from before the version store
   * (CONFLICT_BACKUP_DIR/<backupId>/metadata.json with savedAt) follow the
   * same age limit. Best effort: any failure leaves the backup.
   */
  private async pruneConflictBackups(cutoff: number): Promise<number> {
    let removed = 0;
    try {
      if (!(await this.adapter.exists(CONFLICT_BACKUP_DIR))) return 0;
      const { folders } = await this.adapter.list(CONFLICT_BACKUP_DIR);
      for (const dir of folders.map((f) => fullPath(CONFLICT_BACKUP_DIR, f))) {
        const saved = await this.backupTime(dir);
        if (saved === null || saved >= cutoff) continue;
        try {
          await this.removeTree(dir);
          removed += 1;
        } catch (err) {
          logger.debug(`Removing old conflict backup ${dir} failed:`, err);
        }
      }
    } catch (err) {
      logger.debug("Pruning old conflict backups failed:", err);
    }
    return removed;
  }

  /** savedAt from metadata.json, else the time the backup id starts with. */
  private async backupTime(dir: string): Promise<number | null> {
    try {
      const meta = JSON.parse(await this.adapter.read(`${dir}/metadata.json`)) as { savedAt?: string };
      const ts = meta.savedAt ? Date.parse(meta.savedAt) : NaN;
      if (Number.isFinite(ts)) return ts;
    } catch {
      /* fall back to the folder name */
    }
    const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(dir.slice(dir.lastIndexOf("/") + 1));
    if (!m) return null;
    const ts = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    return Number.isFinite(ts) ? ts : null;
  }

  /** Removes a folder and everything in it, file by file where needed. */
  private async removeTree(dir: string): Promise<void> {
    const { files, folders } = await this.adapter.list(dir);
    for (const f of files) await this.adapter.remove(fullPath(dir, f));
    for (const f of folders) await this.removeTree(fullPath(dir, f));
    if (this.adapter.rmdir) await this.adapter.rmdir(dir, true);
  }
}

/** Groups entries (any order) as VersionStore.groups describes. */
export function groupEntries(entries: VersionEntry[]): VersionGroup[] {
  const groups: VersionGroup[] = [];
  const byBatch = new Map<string, VersionGroup>();
  /** Open time-gap group per peer + op. */
  const open = new Map<string, VersionGroup>();
  const ascending = [...entries].sort((a, b) => a.ts - b.ts);
  for (const e of ascending) {
    let g: VersionGroup | undefined;
    if (e.batch) {
      g = byBatch.get(e.batch);
      if (!g) {
        g = { key: `batch:${e.batch}`, batch: e.batch, peer: e.peer, ops: [], from: e.ts, to: e.ts, entries: [] };
        byBatch.set(e.batch, g);
        groups.push(g);
      }
    } else {
      const k = `${e.peer ?? ""}\u0000${e.op}`;
      g = open.get(k);
      if (!g || e.ts - g.to > GROUP_GAP_MS) {
        g = { key: `t:${e.peer ?? ""}:${e.op}:${e.ts}`, peer: e.peer, ops: [], from: e.ts, to: e.ts, entries: [] };
        open.set(k, g);
        groups.push(g);
      }
    }
    g.entries.push(e);
    g.to = Math.max(g.to, e.ts);
  }
  for (const g of groups) {
    const counts = new Map<string, number>();
    for (const e of g.entries) counts.set(e.op, (counts.get(e.op) ?? 0) + 1);
    g.ops = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([op]) => op);
    g.entries.reverse();
  }
  return groups.sort((a, b) => b.to - a.to);
}
