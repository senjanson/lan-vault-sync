/**
 * Sync health (plan 5.3, 5.4): how each peer's files compare at every file
 * list exchange, and the alerts the user should see.
 *
 * A file that differs at one exchange is normal: the exchange is what sends
 * it. One that still differs at the next is not yet in sync, and one that
 * differs at three exchanges in a row is stuck, which is worth an alert.
 */

import { addStrings } from "../i18n";
import type { EventLog, LogRecord } from "./event-log";

export type AlertKind =
  | "keep-failed"
  | "write-failed"
  | "bulk-held"
  | "state-backup-used"
  | "clock-skew"
  | "file-mismatch"
  | "history-near-cap"
  | "content-shrank";

/** Kinds that describe a state: they go away when the state does. */
const STATE_KINDS = new Set<AlertKind>(["clock-skew", "file-mismatch", "history-near-cap"]);

export interface Alert {
  /** Identifies the alert, for dismiss(). */
  key: string;
  kind: AlertKind;
  msg: string;
  path?: string;
  peer?: string;
  first: number;
  last: number;
  count: number;
}

export interface PeerHealth {
  id: string;
  name?: string;
  /** Last file list exchange. */
  lastExchange?: number;
  /** Last exchange at which every file matched. */
  lastConsistent?: number;
  /** Files that differed at the last exchange. */
  differing: number;
  /** Files that differed at two exchanges in a row or more. */
  unsynced: string[];
  /** Whether the peer's digest of its files matched ours at the last exchange. */
  digestMatch?: boolean;
  /** Files asked of this peer that have not arrived. */
  waiting: number;
  clockOffsetMs?: number;
}

export interface HealthSummary {
  /** Connected peers whose files all matched at the last exchange. */
  consistent: number;
  /** The earliest of those peers' last matching exchanges. */
  since?: number;
  /** Distinct files not yet in sync with some connected peer. */
  unsynced: number;
}

export interface HealthOptions {
  now?: () => number;
  /** Same kind of alert is shown as a notice at most this often. */
  noticeEveryMs?: number;
  /** Exchanges in a row a file must differ to be an alert. */
  stuckRounds?: number;
  /**
   * ...and for at least this long, so that a large file still on its way
   * over a slow network is not called stuck.
   */
  stuckMs?: number;
  clockSkewMs?: number;
  /** Event alerts drop out of the panel after this long. */
  keepEventsMs?: number;
}

interface PeerState {
  name?: string;
  rounds: Map<string, { n: number; since: number }>;
  lastExchange?: number;
  lastConsistent?: number;
  differing: number;
  digestMatch?: boolean;
  waiting: number;
  clockOffsetMs?: number;
}

export class HealthMonitor {
  private peerStates = new Map<string, PeerState>();
  private active = new Map<string, Alert>();
  private lastNotice = new Map<AlertKind, number>();
  private alertListeners = new Set<(a: Alert) => void>();
  private changeListeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly noticeEveryMs: number;
  private readonly stuckRounds: number;
  private readonly stuckMs: number;
  private readonly clockSkewMs: number;
  private readonly keepEventsMs: number;

  constructor(options: HealthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.noticeEveryMs = options.noticeEveryMs ?? 10 * 60 * 1000;
    this.stuckRounds = options.stuckRounds ?? 3;
    this.stuckMs = options.stuckMs ?? 5 * 60 * 1000;
    this.clockSkewMs = options.clockSkewMs ?? 30 * 1000;
    this.keepEventsMs = options.keepEventsMs ?? 24 * 60 * 60 * 1000;
  }

  /** Called when an alert should be shown as a notice (at most once per kind per 10 minutes). */
  onAlert(listener: (a: Alert) => void): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Turns log records that need the user into alerts. */
  watch(log: EventLog): () => void {
    return log.onRecord((r) => this.fromRecord(r));
  }

  private fromRecord(r: LogRecord): void {
    if (r.op === "alert") {
      const kind = (r.rule ?? "") as AlertKind;
      if (kind === "history-near-cap" || kind === "content-shrank" || kind === "state-backup-used") {
        this.alert(kind, r.msg ?? "", { path: r.path, peer: r.peer });
      }
    } else if (r.op === "held" && r.level === "warn") {
      this.alert("bulk-held", r.msg ?? "", { peer: r.peer });
    } else if (r.op === "error" && r.path) {
      // A file operation that failed (connection errors have no path).
      const keep = /could not keep the old version/.test(r.msg ?? "");
      this.alert(keep ? "keep-failed" : "write-failed", r.error ?? r.msg ?? "", { path: r.path, peer: r.peer });
    }
  }

  alert(kind: AlertKind, msg: string, extra: { path?: string; peer?: string; key?: string } = {}): void {
    const now = this.now();
    const key = `${kind}\n${extra.key ?? ""}`;
    const old = this.active.get(key);
    this.active.set(key, {
      key,
      kind,
      msg,
      path: extra.path,
      peer: extra.peer,
      first: old?.first ?? now,
      last: now,
      count: (old?.count ?? 0) + 1,
    });
    const shown = this.lastNotice.get(kind);
    if (shown === undefined || now - shown >= this.noticeEveryMs) {
      this.lastNotice.set(kind, now);
      const a = this.active.get(key)!;
      for (const l of this.alertListeners) {
        try {
          l(a);
        } catch {
          /* a listener must not break sync */
        }
      }
    }
    this.changed();
  }

  /** Remove alerts of a kind (all, or the one with this key). */
  clear(kind: AlertKind, key?: string): void {
    let any = false;
    for (const k of [...this.active.keys()]) {
      if (k.startsWith(`${kind}\n`) && (key === undefined || k === `${kind}\n${key}`)) {
        this.active.delete(k);
        any = true;
      }
    }
    if (any) this.changed();
  }

  /** The user has seen it. */
  dismiss(key: string): void {
    if (this.active.delete(key)) this.changed();
  }

  /** Alerts the panel shows: state alerts while they hold, others for a day. */
  alerts(): Alert[] {
    const now = this.now();
    for (const [k, a] of this.active) {
      if (!STATE_KINDS.has(a.kind) && now - a.last > this.keepEventsMs) this.active.delete(k);
    }
    return [...this.active.values()].sort((a, b) => b.last - a.last);
  }

  /**
   * One file list exchange with a peer. `differing` are the files that
   * differed between the two lists; `clockOffsetMs` the peer's clock minus
   * ours, when known.
   */
  noteExchange(
    peerId: string,
    info: { name?: string; differing: Iterable<string>; digestMatch?: boolean; clockOffsetMs?: number },
  ): void {
    const now = this.now();
    const p = this.peer(peerId);
    if (info.name) p.name = info.name;
    const next = new Map<string, { n: number; since: number }>();
    for (const path of info.differing) {
      const old = p.rounds.get(path);
      next.set(path, { n: (old?.n ?? 0) + 1, since: old?.since ?? now });
    }
    p.rounds = next;
    p.differing = next.size;
    p.lastExchange = now;
    if (next.size === 0) p.lastConsistent = now;
    p.digestMatch = info.digestMatch;
    if (info.clockOffsetMs !== undefined) p.clockOffsetMs = info.clockOffsetMs;

    const stuck = [...next]
      .filter(([, r]) => r.n >= this.stuckRounds && now - r.since >= this.stuckMs)
      .map(([path]) => path);
    const label = p.name ?? peerId;
    if (stuck.length > 0) {
      this.alert("file-mismatch", `${stuck.length} file(s) still differ from ${label}: ${stuck.slice(0, 3).join(", ")}`, {
        peer: label,
        path: stuck[0],
        key: peerId,
      });
    } else {
      this.clear("file-mismatch", peerId);
    }
    if (p.clockOffsetMs !== undefined && Math.abs(p.clockOffsetMs) > this.clockSkewMs) {
      const secs = Math.round(p.clockOffsetMs / 1000);
      this.alert("clock-skew", `${label}'s clock is ${Math.abs(secs)} s ${secs > 0 ? "ahead" : "behind"}`, {
        peer: label,
        key: peerId,
      });
    } else {
      this.clear("clock-skew", peerId);
    }
    this.changed();
  }

  /** Files asked of the peer that have not arrived yet. */
  noteWaiting(peerId: string, count: number): void {
    const p = this.peer(peerId);
    if (p.waiting === count) return;
    p.waiting = count;
    this.changed();
  }

  forgetPeer(peerId: string): void {
    if (!this.peerStates.delete(peerId)) return;
    this.clear("file-mismatch", peerId);
    this.clear("clock-skew", peerId);
    this.changed();
  }

  peers(): PeerHealth[] {
    return [...this.peerStates].map(([id, p]) => ({
      id,
      name: p.name,
      lastExchange: p.lastExchange,
      lastConsistent: p.lastConsistent,
      differing: p.differing,
      unsynced: [...p.rounds].filter(([, r]) => r.n >= 2).map(([path]) => path),
      digestMatch: p.digestMatch,
      waiting: p.waiting,
      clockOffsetMs: p.clockOffsetMs,
    }));
  }

  /** For the status bar, over the peers connected now. */
  summary(connected: string[]): HealthSummary {
    const unsynced = new Set<string>();
    let consistent = 0;
    let since: number | undefined;
    for (const id of connected) {
      const p = this.peerStates.get(id);
      if (!p) continue;
      for (const [path, r] of p.rounds) if (r.n >= 2) unsynced.add(path);
      if (p.lastExchange !== undefined && p.differing === 0) {
        consistent++;
        if (since === undefined || p.lastConsistent! < since) since = p.lastConsistent;
      }
    }
    return { consistent, since, unsynced: unsynced.size };
  }

  private peer(id: string): PeerState {
    let p = this.peerStates.get(id);
    if (!p) {
      p = { rounds: new Map(), differing: 0, waiting: 0 };
      this.peerStates.set(id, p);
    }
    return p;
  }

  private changed(): void {
    for (const l of this.changeListeners) {
      try {
        l();
      } catch {
        /* ignore */
      }
    }
  }
}

/** A digest of a file list (plan 5.3): sorted "path\thash" lines, FNV-1a 64 as hex. */
export function vaultDigest(files: Iterable<{ path: string; hash: string }>): string {
  const lines = [...files].map((f) => `${f.path}\t${f.hash}`).sort();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    h1 = Math.imul(h1 ^ 10, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ 10, 0x5bd1e995) >>> 0;
  }
  return `${lines.length}:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

addStrings("en", {
  "alert.keep-failed": "LAN Vault Sync skipped a change because the old version could not be kept: {msg}",
  "alert.write-failed": "LAN Vault Sync could not write a file: {msg}",
  "alert.bulk-held": "LAN Vault Sync is holding deletions for your confirmation.",
  "alert.state-backup-used": "LAN Vault Sync found a damaged state file and used its backup: {msg}",
  "alert.clock-skew": "LAN Vault Sync: {msg}. Set both devices to the right time, or the later edit may be judged wrongly.",
  "alert.file-mismatch": "LAN Vault Sync: {msg}. Open the sync panel for details.",
  "alert.history-near-cap": "LAN Vault Sync: {msg}. The oldest versions will be removed first.",
  "alert.content-shrank": "LAN Vault Sync: {msg}. The earlier version is in the recovery center.",
  "health.title": "Health",
  "health.alerts": "Alerts",
  "health.noPeers": "No file list exchanged yet.",
  "health.consistent": "{name}: all files match (checked {time})",
  "health.differing": "{name}: {count} file(s) not yet in sync (checked {time})",
  "health.pending": "{name}: being compared (checked {time})",
  "health.waiting": "waiting for {count} file(s)",
  "health.clock": "clock off by {secs} s",
  "health.dismiss": "Dismiss",
  "health.export": "Export diagnostics",
  "cmd.exportDiagnostics": "Export diagnostics (sync key masked)",
  "notice.diagnostics": "Diagnostics saved to {path}. The sync key is masked.",
  "notice.diagnosticsCopied": "Diagnostics saved to {path} and copied. The sync key is masked.",
  "status.consistent": "LAN Sync: in sync with {count} · {time}",
  "status.unsynced": "LAN Sync: {count} file(s) not in sync",
});

addStrings("zh", {
  "alert.keep-failed": "LAN Vault Sync 跳过了一次修改，因为没能保存旧版本：{msg}",
  "alert.write-failed": "LAN Vault Sync 没能写入文件：{msg}",
  "alert.bulk-held": "LAN Vault Sync 暂停了一批删除，等你确认。",
  "alert.state-backup-used": "LAN Vault Sync 发现状态文件损坏，已改用备份：{msg}",
  "alert.clock-skew": "LAN Vault Sync：{msg}。请把两台设备的时间调准，否则可能判错哪次修改更晚。",
  "alert.file-mismatch": "LAN Vault Sync：{msg}。详情见同步面板。",
  "alert.history-near-cap": "LAN Vault Sync：{msg}。会先删除最旧的版本。",
  "alert.content-shrank": "LAN Vault Sync：{msg}。之前的版本在恢复中心里。",
  "health.title": "健康状况",
  "health.alerts": "提醒",
  "health.noPeers": "还没有交换过文件列表。",
  "health.consistent": "{name}：文件全部一致（{time} 检查）",
  "health.differing": "{name}：{count} 个文件未一致（{time} 检查）",
  "health.pending": "{name}：正在比对（{time} 检查）",
  "health.waiting": "等待 {count} 个文件",
  "health.clock": "时钟相差 {secs} 秒",
  "health.dismiss": "知道了",
  "health.export": "导出诊断信息",
  "cmd.exportDiagnostics": "导出诊断信息（同步密钥已遮盖）",
  "notice.diagnostics": "诊断信息已保存到 {path}，同步密钥已遮盖。",
  "notice.diagnosticsCopied": "诊断信息已保存到 {path} 并已复制，同步密钥已遮盖。",
  "status.consistent": "LAN Sync：已与 {count} 台一致 · {time}",
  "status.unsynced": "LAN Sync：{count} 个文件未一致",
});
