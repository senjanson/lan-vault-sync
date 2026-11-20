/**
 * Persistent sync log: one JSON line per event, appended to
 * `.lan-vault-sync/logs/sync-YYYY-MM-DD.jsonl` in the vault. Phones write
 * slowly, so lines are buffered and flushed every ~1.5 s, or at once on
 * flush() (called from persist() when the app goes to the background).
 *
 * The folder starts with a dot, so the sync code never sends it to peers.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogOp =
  | "overwrite"
  | "delete"
  | "rename"
  | "conflict-copy"
  | "skip"
  | "held"
  | "precondition-failed"
  | "error"
  | "connect"
  | "disconnect"
  | "tree-exchange"
  | "version"
  | "restore"
  | "alert"
  | "log";

export interface ContentRef {
  hash?: string;
  size?: number;
}

export interface LogRecord {
  ts: number;
  seq: number;
  level: LogLevel;
  op: LogOp;
  path?: string;
  /** Peer as "deviceId (name)". */
  peer?: string;
  before?: ContentRef;
  after?: ContentRef;
  /** The rule that made the decision, e.g. "tombstone-covers". */
  rule?: string;
  /** Hash of the old version kept in the version store. */
  version?: string;
  batch?: string;
  error?: string;
  msg?: string;
}

export type LogInput = Omit<LogRecord, "ts" | "seq" | "level"> & { level?: LogLevel };

/** The part of Obsidian's DataAdapter the log needs. */
export interface LogAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  append?(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat?(path: string): Promise<{ size: number } | null>;
}

export const DATA_DIR = ".lan-vault-sync";
export const LOG_DIR = `${DATA_DIR}/logs`;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EventLogOptions {
  dir?: string;
  flushMs?: number;
  keepDays?: number;
  maxBytes?: number;
  now?: () => number;
}

function dayOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class EventLog {
  private buffer: LogRecord[] = [];
  private seq = 0;
  private timer: number | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirReady = false;
  private listeners = new Set<(r: LogRecord) => void>();
  private recent: LogRecord[] = [];
  private readonly dir: string;
  private readonly flushMs: number;
  private readonly keepDays: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  /** Set when a write failed, so the error is not repeated for every flush. */
  lastWriteError: string | null = null;

  constructor(
    private adapter: LogAdapter | null,
    options: EventLogOptions = {},
  ) {
    this.dir = options.dir ?? LOG_DIR;
    this.flushMs = options.flushMs ?? 1500;
    this.keepDays = options.keepDays ?? 14;
    this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    this.now = options.now ?? Date.now;
  }

  record(input: LogInput): LogRecord {
    const rec: LogRecord = {
      ts: this.now(),
      seq: ++this.seq,
      level: input.level ?? (input.op === "error" ? "error" : "info"),
      ...input,
    } as LogRecord;
    for (const key of Object.keys(rec) as Array<keyof LogRecord>) {
      if (rec[key] === undefined) delete rec[key];
    }
    this.recent.push(rec);
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);
    for (const l of this.listeners) {
      try {
        l(rec);
      } catch {
        /* a listener must not break logging */
      }
    }
    if (!this.adapter) return rec;
    this.buffer.push(rec);
    if (!this.timer) {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushMs);
    }
    return rec;
  }

  onRecord(listener: (r: LogRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Records from this run, oldest first (at most 500). */
  recentRecords(): LogRecord[] {
    return [...this.recent];
  }

  /** Writes everything buffered. Safe to call often. */
  flush(): Promise<void> {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.writing = this.writing.then(() => this._write());
    return this.writing;
  }

  private async _write(): Promise<void> {
    if (!this.adapter || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const byDay = new Map<string, string>();
    for (const r of batch) {
      const file = `${this.dir}/sync-${dayOf(r.ts)}.jsonl`;
      byDay.set(file, (byDay.get(file) ?? "") + JSON.stringify(r) + "\n");
    }
    try {
      await this._ensureDir();
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
      // Keep the lines for the next try, but never grow without bound.
      this.buffer = batch.concat(this.buffer).slice(-5000);
      const msg = e instanceof Error ? e.message : String(e);
      if (this.lastWriteError !== msg) console.error("[LAN-Vault-Sync] cannot write sync log:", msg);
      this.lastWriteError = msg;
    }
  }

  private async _ensureDir(): Promise<void> {
    if (this.dirReady || !this.adapter) return;
    let path = "";
    for (const part of this.dir.split("/")) {
      path = path ? `${path}/${part}` : part;
      if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
    }
    this.dirReady = true;
  }

  /** Lists the day files, oldest first. */
  async files(): Promise<string[]> {
    if (!this.adapter || !(await this.adapter.exists(this.dir))) return [];
    const { files } = await this.adapter.list(this.dir);
    return files
      .map((f) => (f.includes("/") ? f : `${this.dir}/${f}`))
      .filter((f) => /sync-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  }

  /** Drops day files older than keepDays, then the oldest until under maxBytes. */
  async prune(): Promise<void> {
    if (!this.adapter) return;
    await this.flush();
    const files = await this.files();
    const cutoff = dayOf(this.now() - this.keepDays * DAY_MS);
    const kept: Array<{ file: string; size: number }> = [];
    for (const file of files) {
      const day = file.slice(-16, -6);
      if (day < cutoff) {
        await this.adapter.remove(file).catch(() => undefined);
        continue;
      }
      kept.push({ file, size: await this._size(file) });
    }
    let total = kept.reduce((s, f) => s + f.size, 0);
    // Never remove today's file: it holds what is being investigated now.
    while (total > this.maxBytes && kept.length > 1) {
      const oldest = kept.shift()!;
      await this.adapter.remove(oldest.file).catch(() => undefined);
      total -= oldest.size;
    }
  }

  private async _size(file: string): Promise<number> {
    if (!this.adapter) return 0;
    if (this.adapter.stat) {
      const st = await this.adapter.stat(file).catch(() => null);
      if (st) return st.size;
    }
    const text = await this.adapter.read(file).catch(() => "");
    return text.length;
  }

  /** Reads back records from disk, newest last; for diagnostics and tests. */
  async readAll(maxLines = 20000): Promise<LogRecord[]> {
    if (!this.adapter) return this.recentRecords();
    await this.flush();
    const out: LogRecord[] = [];
    for (const file of await this.files()) {
      const text = await this.adapter.read(file).catch(() => "");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as LogRecord);
        } catch {
          /* a line cut short by a crash */
        }
      }
    }
    return out.slice(-maxLines);
  }
}

/** Formats a peer for the log: "deviceId (name)". */
export function peerLabel(id?: string, name?: string): string | undefined {
  if (!id) return undefined;
  return name && name !== id ? `${id} (${name})` : id;
}
