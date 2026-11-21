/**
 * Sync health (plan 5.3, 5.4): how each peer's files compare at every file
 * list exchange, and the alerts the user should see.
 *
 * A file that differs at one exchange is normal: the exchange is what sends
 * it. One that still differs at the next is not yet in sync, and one that
 * differs at three exchanges in a row is stuck, which is worth an alert.
 */

import { addStrings, t } from "../i18n";
import { readJsonWithBackup, writeAtomic, type AtomicAdapter } from "../utils/atomic-write";
import { ensureParentDirectory } from "../utils/path-utils";
import { logger } from "../logger";
import { DATA_DIR, type EventLog, type LogRecord } from "./event-log";

/**
 * Each device this one has synced with: its name, when it was last seen
 * and when its files last all matched, so that a device that is away is
 * still listed after a restart (see attachPeerStore). Starts with a dot, so
 * it is not synced.
 */
export const PEERS_FILE = `${DATA_DIR}/peers.json`;

/** PEERS_FILE as saved. */
interface SavedPeers {
  version: 1;
  peers: Record<string, { name?: string; lastConsistent?: number; lastSeen?: number }>;
}

export type AlertKind =
  | "keep-failed"
  | "write-failed"
  | "bulk-held"
  | "state-backup-used"
  | "clock-skew"
  | "file-mismatch"
  | "history-near-cap"
  | "content-shrank"
  | "too-large"
  | "scope-disjoint"
  | "scope-missing";

/** Kinds that describe a state: they go away when the state does. */
const STATE_KINDS = new Set<AlertKind>(["clock-skew", "file-mismatch", "history-near-cap", "scope-disjoint", "scope-missing"]);

/** State alerts about one peer (keyed by its ID), which go when it is forgotten. */
const PEER_KINDS: AlertKind[] = ["file-mismatch", "clock-skew", "scope-disjoint", "scope-missing"];

/**
 * Alerts about one file's step that failed (keyed by its path). They go
 * when a later step on that path succeeds, or the file is gone.
 */
const PATH_KINDS: AlertKind[] = ["keep-failed", "write-failed"];

/** Log ops that report a step on a file that was carried out. */
const DONE_OPS = new Set<LogRecord["op"]>(["overwrite", "delete", "rename", "restore"]);

/** A file as the file lists give it, for tooLargeToSync. */
interface ListedFile {
  path: string;
  size: number;
  isTextFile?: boolean;
}

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
  /** Values for the alert's text in the user's language (see alertText). */
  params?: Record<string, string | number>;
}

/** A device as the user knows it: its name, out of "deviceId (name)". */
export function peerName(label: string | undefined): string {
  if (!label) return "?";
  const m = /\((.+)\)$/.exec(label);
  return m ? m[1] : label;
}

/** An alert's text in the user's language. */
export function alertText(a: Pick<Alert, "kind" | "msg" | "params">): string {
  let p = a.params ?? {};
  if (a.kind === "scope-disjoint") {
    // A side's folder, or "" for the whole vault, said in the user's language.
    const side = (v: string | number | undefined) =>
      v === undefined || v === "" ? t("scope.wholeVault") : t("scope.folder", { folder: String(v) });
    p = { ...p, here: side(p.here), there: side(p.there) };
  }
  const key =
    a.kind === "clock-skew" && p.ahead === 0
      ? "alert.clock-skew-behind"
      : a.kind === "content-shrank" && p.who
        ? "alert.content-shrank-by"
        : `alert.${a.kind}`;
  return t(key, { msg: a.msg, ...p });
}

export interface PeerHealth {
  id: string;
  name?: string;
  /**
   * False once it disconnected. A device that is away stays listed, also
   * after a restart, until it has not been seen for forgetPeerAfterMs.
   */
  connected: boolean;
  /** When it was last connected (now, while it is). */
  lastSeen?: number;
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
  /** Files of the peer's that this device does not take, for their size (maxReceiveMB). */
  tooLargeHere: string[];
  /** Files of ours that the peer does not take, for their size (its maxReceiveMB). */
  tooLargeThere: string[];
  /** The folder this connection is limited to, when it is (see notePeerScope). */
  only?: string;
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
  /**
   * A device not seen for this long is forgotten (30 days). Until then it is
   * listed as disconnected, with when its files last all matched.
   */
  forgetPeerAfterMs?: number;
  /**
   * What was compared with a device (files not in sync, its clock, its
   * folder) and the alerts about it are dropped once it has been away for
   * this long (30 minutes): they say nothing of a device that is not there.
   */
  dropPeerStateAfterMs?: number;
  /** PEERS_FILE is saved this long after a change... */
  saveDelayMs?: number;
  /**
   * ...and, when only times moved (each file list exchange moves them), at
   * most this often. flushPeers saves at once.
   */
  saveEveryMs?: number;
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
  tooLargeHere: string[];
  tooLargeThere: string[];
  /** When it disconnected; unset while connected. */
  disconnectedAt?: number;
  /** When it was last connected; see PeerHealth.lastSeen. */
  lastSeen?: number;
  /** See notePeerScope. */
  only?: string;
  /** Its comparison was dropped while it was away (see dropPeerStateAfterMs). */
  dropped?: boolean;
}

/**
 * The ID and the name out of a log record's "deviceId (name)"; no name
 * when the record gives only the ID.
 */
function parsePeer(label: string): { id: string; name?: string } {
  const m = /^(\S+) \((.+)\)$/.exec(label);
  return m ? { id: m[1], name: m[2] } : { id: label };
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
  private readonly forgetPeerAfterMs: number;
  private readonly dropPeerStateAfterMs: number;
  private readonly saveDelayMs: number;
  private readonly saveEveryMs: number;
  /** Where PEERS_FILE is kept; null until attachPeerStore. */
  private store: AtomicAdapter | null = null;
  /** Reading PEERS_FILE; a save waits for it, so that it never writes over what was there unread. */
  private loading: Promise<void> | null = null;
  private saveTimer: number | null = null;
  private saveDue = 0;
  private dirty = false;
  private lastSaved = "";
  private lastSavedAt = -Infinity;
  private saving: Promise<void> = Promise.resolve();

  constructor(options: HealthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.noticeEveryMs = options.noticeEveryMs ?? 10 * 60 * 1000;
    this.stuckRounds = options.stuckRounds ?? 3;
    this.stuckMs = options.stuckMs ?? 5 * 60 * 1000;
    this.clockSkewMs = options.clockSkewMs ?? 30 * 1000;
    this.keepEventsMs = options.keepEventsMs ?? 24 * 60 * 60 * 1000;
    this.forgetPeerAfterMs = options.forgetPeerAfterMs ?? 30 * 24 * 60 * 60 * 1000;
    this.dropPeerStateAfterMs = options.dropPeerStateAfterMs ?? 30 * 60 * 1000;
    this.saveDelayMs = options.saveDelayMs ?? 5 * 1000;
    this.saveEveryMs = options.saveEveryMs ?? 60 * 1000;
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
        const file = kind === "state-backup-used" ? (r.msg ?? "").split(":")[0] : r.path ?? "";
        // The device whose change emptied a note is named when the record has it.
        const who = kind === "content-shrank" && r.peer ? peerName(r.peer) : "";
        this.alert(kind, r.msg ?? "", { path: r.path, peer: r.peer, params: who ? { path: file, who } : { path: file } });
      }
    } else if (r.op === "held" && r.level === "warn") {
      // One per batch, cleared when the batch no longer waits (keepHeld).
      this.alert("bulk-held", r.msg ?? "", { peer: r.peer, key: r.batch });
    } else if (r.op === "skip" && r.rule === "too-large") {
      // A file that will not reach this device until the limit is raised.
      this.alert("too-large", `${r.path}: ${r.msg ?? ""}`, { path: r.path, peer: r.peer, key: r.path, params: { path: r.path ?? "" } });
    } else if (r.op === "error" && r.path) {
      // A file operation that failed (connection errors have no path).
      const keep = /could not keep the old version/.test(r.msg ?? "");
      this.alert(keep ? "keep-failed" : "write-failed", r.error ?? r.msg ?? "", { path: r.path, peer: r.peer, key: r.path });
    } else if (r.path && r.level === "info" && DONE_OPS.has(r.op)) {
      // A later step on the file went through: whatever failed before
      // (the version store was not writable, say) works again.
      for (const kind of PATH_KINDS) this.clear(kind, r.path);
    } else if (r.op === "connect" && r.peer) {
      const { id, name } = parsePeer(r.peer);
      this.notePeerConnected(id, name);
    } else if (r.op === "disconnect" && r.peer) {
      this.notePeerDisconnected(parsePeer(r.peer).id);
    }
  }

  /**
   * The held deletion batches still waiting (by ID); the alerts of the
   * others go, as nothing of theirs is held any more.
   */
  keepHeld(ids: Iterable<string>): void {
    const keep = new Set([...ids].map((id) => `bulk-held\n${id}`));
    let any = false;
    for (const [k, a] of this.active) {
      if (a.kind === "bulk-held" && !keep.has(k)) {
        this.active.delete(k);
        any = true;
      }
    }
    if (any) this.changed();
  }

  /** The file is no longer at this path (deleted, or renamed away). */
  notePathGone(path: string): void {
    for (const kind of PATH_KINDS) this.clear(kind, path);
    this.clear("too-large", path);
  }

  /**
   * The file at this path was written. A write that failed works now; a
   * version that could not be kept is still not kept, so that alert stays.
   */
  notePathWritten(path: string): void {
    this.clear("write-failed", path);
    this.clear("too-large", path);
  }

  alert(
    kind: AlertKind,
    msg: string,
    extra: { path?: string; peer?: string; key?: string; params?: Record<string, string | number> } = {},
  ): void {
    const now = this.now();
    const key = `${kind}\n${extra.key ?? ""}`;
    const old = this.active.get(key);
    this.active.set(key, {
      key,
      kind,
      msg,
      path: extra.path,
      peer: extra.peer,
      params: extra.params,
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
    info: {
      name?: string;
      differing: Iterable<string>;
      digestMatch?: boolean;
      clockOffsetMs?: number;
      /** Files among `differing` that one side does not take for their size. */
      tooLarge?: { here?: Iterable<string>; there?: Iterable<string> };
    },
  ): void {
    const now = this.now();
    const p = this.peer(peerId);
    if (info.name && p.name !== info.name) {
      p.name = info.name;
      this.markDirty(true);
    }
    p.dropped = false;
    // Apart on purpose (see tooLargeToSync): listed on their own, not as
    // files that are not yet in sync.
    p.tooLargeHere = [...(info.tooLarge?.here ?? [])].sort();
    p.tooLargeThere = [...(info.tooLarge?.there ?? [])].sort();
    // A file this device did not take from this peer, which the peer no
    // longer lists as too large here (deleted there, or made smaller):
    // nothing is left to receive, so its alert goes.
    const stillHere = new Set(p.tooLargeHere);
    for (const a of [...this.active.values()]) {
      if (a.kind === "too-large" && a.path && p.name && a.peer === p.name && !stillHere.has(a.path)) {
        this.clear("too-large", a.path);
      }
    }
    const apart = new Set([...p.tooLargeHere, ...p.tooLargeThere]);
    const next = new Map<string, { n: number; since: number }>();
    for (const path of info.differing) {
      if (apart.has(path)) continue;
      const old = p.rounds.get(path);
      next.set(path, { n: (old?.n ?? 0) + 1, since: old?.since ?? now });
    }
    p.rounds = next;
    p.differing = next.size;
    p.lastExchange = now;
    if (next.size === 0) p.lastConsistent = now;
    // An exchange is over a connection.
    if (p.disconnectedAt === undefined) p.lastSeen = now;
    this.markDirty(false);
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
        params: { count: stuck.length, peer: peerName(label), files: stuck.slice(0, 3).join(", ") },
      });
    } else {
      this.clear("file-mismatch", peerId);
    }
    if (p.clockOffsetMs !== undefined && Math.abs(p.clockOffsetMs) > this.clockSkewMs) {
      const secs = Math.round(p.clockOffsetMs / 1000);
      this.alert("clock-skew", `${label}'s clock is ${Math.abs(secs)} s ${secs > 0 ? "ahead" : "behind"}`, {
        peer: label,
        key: peerId,
        params: { peer: peerName(label), secs: Math.abs(secs), ahead: secs > 0 ? 1 : 0 },
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

  /**
   * Of the files that differ in a file list exchange, those that differ
   * because one side does not take files that large (maxReceiveMB): the
   * peer's version over this device's limit (`here`), or ours over the
   * peer's (`there`, as the peer gave it in its handshake). They stay apart
   * by design. Notes are synced through their history, not as files, and
   * have no limit. A limit of 0 is none.
   */
  static tooLargeToSync(
    diff: {
      localOnly: ListedFile[];
      remoteOnly: ListedFile[];
      conflicting: Array<{ local: ListedFile; remote: ListedFile }>;
    },
    limitHere: number,
    limitThere: number,
  ): { here: string[]; there: string[] } {
    const over = (f: ListedFile, limit: number) => limit > 0 && !f.isTextFile && f.size > limit;
    const here: string[] = [];
    const there: string[] = [];
    for (const f of diff.remoteOnly) if (over(f, limitHere)) here.push(f.path);
    for (const f of diff.localOnly) if (over(f, limitThere)) there.push(f.path);
    for (const c of diff.conflicting) {
      if (over(c.remote, limitHere)) here.push(c.remote.path);
      else if (over(c.local, limitThere)) there.push(c.local.path);
    }
    return { here, there };
  }

  forgetPeer(peerId: string): void {
    if (!this.peerStates.delete(peerId)) return;
    for (const kind of PEER_KINDS) this.clear(kind, peerId);
    this.markDirty(true);
    this.changed();
  }

  /**
   * The folders a connection with a peer is limited to; each call replaces
   * what was said before. `only`: the folder both sides sync, when the
   * connection is limited to one (listed with the device). `disjoint`: the
   * two sides' folders ("" for the whole vault) do not overlap, so nothing
   * syncs. `missingHere`: the peer's folder is not in this vault.
   */
  notePeerScope(
    peerId: string,
    info: { only?: string; disjoint?: { here: string; there: string }; missingHere?: string },
  ): void {
    const p = this.peer(peerId);
    p.only = info.only || undefined;
    const label = p.name ?? peerId;
    const name = peerName(label);
    if (info.disjoint) {
      const params = { peer: name, here: info.disjoint.here, there: info.disjoint.there };
      this.stateAlert("scope-disjoint", peerId, `Nothing syncs with ${label}: this device syncs "${params.here}", it syncs "${params.there}"`, label, params);
    } else {
      this.clear("scope-disjoint", peerId);
    }
    if (info.missingHere !== undefined) {
      const params = { peer: name, folder: info.missingHere };
      this.stateAlert("scope-missing", peerId, `${label} syncs only "${info.missingHere}", which is not in this vault`, label, params);
    } else {
      this.clear("scope-missing", peerId);
    }
    this.changed();
  }

  /** A state alert, raised again only when what it says changed. */
  private stateAlert(kind: AlertKind, peerId: string, msg: string, peer: string, params: Record<string, string>): void {
    const old = this.active.get(`${kind}\n${peerId}`);
    if (old && JSON.stringify(old.params) === JSON.stringify(params)) return;
    this.alert(kind, msg, { peer, key: peerId, params });
  }

  /*
   * Devices that are gone. A device is listed while connected, and for
   * forgetPeerAfterMs (30 minutes) after it disconnects, shown as
   * disconnected and not counted in the summary; then it is forgotten. It
   * is forgotten at once when a device of the same name connects under
   * another ID: that is the same device with a new ID (its settings were
   * changed, or it was given a new ID), and the old ID will not come back.
   * A device of the same name that is still connected is another device
   * and is kept. Connections are learned from the log's connect and
   * disconnect records (see watch).
   */

  notePeerConnected(peerId: string, name?: string): void {
    const known = this.peerStates.has(peerId);
    const p = this.peer(peerId);
    p.disconnectedAt = undefined;
    p.lastSeen = this.now();
    this.markDirty(!known);
    if (name) {
      if (!p.name || peerName(p.name) !== name) {
        p.name = `${peerId} (${name})`;
        this.markDirty(true);
      }
      for (const [id, other] of [...this.peerStates]) {
        if (id !== peerId && other.disconnectedAt !== undefined && other.name && peerName(other.name) === name) {
          this.forgetPeer(id);
        }
      }
    }
    this.changed();
  }

  notePeerDisconnected(peerId: string): void {
    const p = this.peerStates.get(peerId);
    if (!p || p.disconnectedAt !== undefined) return;
    p.disconnectedAt = this.now();
    p.lastSeen = p.disconnectedAt;
    p.dropped = false;
    this.markDirty(true);
    this.changed();
  }

  /**
   * Forgets the devices not seen for forgetPeerAfterMs, and drops what was
   * compared with those away for dropPeerStateAfterMs.
   */
  private _forgetGone(): void {
    const now = this.now();
    for (const [id, p] of [...this.peerStates]) {
      if (p.disconnectedAt === undefined) continue;
      if (now - p.disconnectedAt >= this.forgetPeerAfterMs) {
        this.forgetPeer(id);
      } else if (!p.dropped && now - p.disconnectedAt >= this.dropPeerStateAfterMs) {
        p.dropped = true;
        p.rounds = new Map();
        p.differing = 0;
        p.digestMatch = undefined;
        p.waiting = 0;
        p.clockOffsetMs = undefined;
        p.tooLargeHere = [];
        p.tooLargeThere = [];
        p.only = undefined;
        for (const kind of PEER_KINDS) this.clear(kind, id);
      }
    }
  }

  peers(): PeerHealth[] {
    this._forgetGone();
    return [...this.peerStates].map(([id, p]) => ({
      id,
      name: p.name,
      connected: p.disconnectedAt === undefined,
      lastSeen: p.lastSeen,
      lastExchange: p.lastExchange,
      lastConsistent: p.lastConsistent,
      differing: p.differing,
      unsynced: [...p.rounds].filter(([, r]) => r.n >= 2).map(([path]) => path),
      digestMatch: p.digestMatch,
      waiting: p.waiting,
      clockOffsetMs: p.clockOffsetMs,
      tooLargeHere: p.tooLargeHere,
      tooLargeThere: p.tooLargeThere,
      only: p.only,
    }));
  }

  /** For the status bar, over the peers connected now. */
  summary(connected: string[]): HealthSummary {
    this._forgetGone();
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
      p = { rounds: new Map(), differing: 0, waiting: 0, tooLargeHere: [], tooLargeThere: [] };
      this.peerStates.set(id, p);
      this.markDirty(true);
    }
    return p;
  }

  /*
   * Keeping the devices across restarts (PEERS_FILE): each one's name, when
   * it was last seen and when its files last all matched. A device read
   * back is listed as disconnected since it was last seen.
   */

  /**
   * Reads PEERS_FILE through the vault's adapter and saves it there from
   * now on. What is already known here (a device that connected while it
   * was read) is newer and is kept. Does nothing without an adapter that
   * can read and write; a file that cannot be read is ignored.
   */
  attachPeerStore(adapter: unknown): Promise<void> {
    const a = adapter as Partial<AtomicAdapter> | null | undefined;
    if (!a || typeof a.exists !== "function" || typeof a.read !== "function" || typeof a.write !== "function") {
      return Promise.resolve();
    }
    this.store = a as AtomicAdapter;
    const loading = this.loadPeers(this.store);
    this.loading = loading;
    return loading;
  }

  private async loadPeers(adapter: AtomicAdapter): Promise<void> {
    let saved: Partial<SavedPeers> | null = null;
    try {
      saved = await readJsonWithBackup<Partial<SavedPeers>>(adapter, PEERS_FILE);
    } catch (err) {
      logger.warn(`Could not read ${PEERS_FILE}:`, err);
    }
    const peers = saved && typeof saved === "object" && saved.peers && typeof saved.peers === "object" ? saved.peers : {};
    const now = this.now();
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    let any = false;
    for (const [id, entry] of Object.entries(peers)) {
      if (!id || !entry || typeof entry !== "object") continue;
      const name = typeof entry.name === "string" && entry.name ? entry.name : undefined;
      const lastConsistent = num(entry.lastConsistent);
      const lastSeen = num(entry.lastSeen) ?? lastConsistent;
      if (lastSeen === undefined || now - lastSeen >= this.forgetPeerAfterMs) continue;
      const p = this.peerStates.get(id);
      if (p) {
        // Connected while the file was read: what is known now wins.
        if (!p.name && name) p.name = name;
        if (lastConsistent !== undefined && (p.lastConsistent === undefined || lastConsistent > p.lastConsistent)) {
          p.lastConsistent = lastConsistent;
        }
        if (p.lastSeen === undefined || lastSeen > p.lastSeen) p.lastSeen = lastSeen;
        any = true;
        continue;
      }
      // The same device under a new ID connected meanwhile: the old ID will
      // not come back (see notePeerConnected).
      if (name && [...this.peerStates.values()].some((o) => o.name && peerName(o.name) === peerName(name))) continue;
      this.peerStates.set(id, {
        name,
        rounds: new Map(),
        differing: 0,
        waiting: 0,
        tooLargeHere: [],
        tooLargeThere: [],
        lastConsistent,
        lastSeen,
        disconnectedAt: lastSeen,
        dropped: true,
      });
      any = true;
    }
    // Saved before the file was read (a device connected meanwhile): save now.
    if (this.dirty) this.markDirty(true);
    if (any) this.changed();
  }

  /** Saves PEERS_FILE now, when something in it changed. */
  async flushPeers(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.savePeers();
  }

  /**
   * Something PEERS_FILE holds changed. `soon`: a device came, went or was
   * renamed; otherwise only times moved, which is saved at most every
   * saveEveryMs.
   */
  private markDirty(soon: boolean): void {
    this.dirty = true;
    if (!this.store) return;
    const now = this.now();
    const due = Math.max(now + this.saveDelayMs, soon ? 0 : this.lastSavedAt + this.saveEveryMs);
    if (this.saveTimer && this.saveDue <= due) return;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveDue = due;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.savePeers();
    }, due - now);
  }

  private serializePeers(): string {
    const peers: SavedPeers["peers"] = {};
    for (const [id, p] of [...this.peerStates].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      // Known only from a file request, say: nothing to keep.
      if (p.lastSeen === undefined && p.lastConsistent === undefined && p.disconnectedAt === undefined) continue;
      peers[id] = { name: p.name, lastConsistent: p.lastConsistent, lastSeen: p.lastSeen ?? p.disconnectedAt };
    }
    return JSON.stringify({ version: 1, peers } satisfies SavedPeers);
  }

  private savePeers(): Promise<void> {
    const run = this.saving.then(async () => {
      const adapter = this.store;
      if (!adapter || !this.dirty) return;
      if (this.loading) await this.loading;
      this.dirty = false;
      const text = this.serializePeers();
      if (text === this.lastSaved) return;
      try {
        const withDirs = adapter as AtomicAdapter & { mkdir?(path: string): Promise<void> };
        if (typeof withDirs.mkdir === "function") {
          await ensureParentDirectory(withDirs as AtomicAdapter & { mkdir(path: string): Promise<void> }, PEERS_FILE);
        }
        await writeAtomic(adapter, PEERS_FILE, text);
        this.lastSaved = text;
        this.lastSavedAt = this.now();
      } catch (err) {
        this.dirty = true;
        logger.warn(`Could not save ${PEERS_FILE}:`, err);
      }
    });
    this.saving = run.catch(() => undefined);
    return run;
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
  "alert.state-backup-used": "LAN Vault Sync found a damaged state file ({path}) and used its backup. Changes saved just before it may need to sync again.",
  "alert.clock-skew": "LAN Vault Sync: {peer}'s clock is {secs} s ahead of this device's. Set both devices to the right time, or the later edit may be judged wrongly.",
  "alert.clock-skew-behind": "LAN Vault Sync: {peer}'s clock is {secs} s behind this device's. Set both devices to the right time, or the later edit may be judged wrongly.",
  "alert.file-mismatch": "LAN Vault Sync: {count} file(s) still differ from {peer}: {files}. Open the sync panel for details.",
  "alert.history-near-cap": "LAN Vault Sync: the version history is near its space limit. The oldest versions will be removed first.",
  "alert.content-shrank": "LAN Vault Sync: a change from another device emptied or cut short {path}. The earlier version is in the recovery center.",
  "alert.content-shrank-by": "LAN Vault Sync: a change from {who} emptied or cut short {path}. The earlier version is in the recovery center.",
  "alert.too-large": "LAN Vault Sync did not take {path}: it is larger than this device's limit for received files. Raise “Largest file to receive” in settings to sync it.",
  "health.title": "Health",
  "health.alerts": "Alerts",
  "health.noPeers": "No file list exchanged yet.",
  "health.consistent": "{name}: all files match (checked {time})",
  "health.differing": "{name}: {count} file(s) not yet in sync (checked {time})",
  "health.pending": "{name}: being compared (checked {time})",
  "health.waiting": "waiting for {count} file(s)",
  "health.clock": "clock off by {secs} s",
  "alert.scope-disjoint": "LAN Vault Sync: nothing is synced with {peer}. This device syncs {here} and {peer} syncs {there}, which do not overlap. Change “Sync only this folder” on one of them.",
  "alert.scope-missing": "LAN Vault Sync: {peer} syncs only the folder “{folder}”, and this vault has no folder of that name. If yours is named differently (case matters), rename it to match.",
  "scope.wholeVault": "the whole vault",
  "scope.folder": "the folder “{folder}”",
  "health.disconnected": "{name}: disconnected · last in sync {time}",
  "health.disconnectedNever": "{name}: disconnected · not fully in sync yet",
  "health.only": "syncs only {folder}",
  "health.tooLargeHere": "{count} file(s) not received: larger than this device's limit",
  "health.tooLargeThere": "{count} file(s) not sent: larger than {name}'s limit",
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
  "alert.state-backup-used": "LAN Vault Sync 发现状态文件（{path}）损坏，已改用备份。损坏前刚保存的改动可能需要重新同步。",
  "alert.clock-skew": "LAN Vault Sync：{peer} 的时钟比本设备快 {secs} 秒。请把两台设备的时间调准，否则可能判错哪次修改更晚。",
  "alert.clock-skew-behind": "LAN Vault Sync：{peer} 的时钟比本设备慢 {secs} 秒。请把两台设备的时间调准，否则可能判错哪次修改更晚。",
  "alert.file-mismatch": "LAN Vault Sync：有 {count} 个文件与 {peer} 仍不一致：{files}。详情见同步面板。",
  "alert.history-near-cap": "LAN Vault Sync：版本历史快到空间上限了，会先删除最旧的版本。",
  "alert.content-shrank": "LAN Vault Sync：其他设备的修改清空了 {path}，或删掉了它的大半内容。之前的版本在恢复中心里。",
  "alert.content-shrank-by": "LAN Vault Sync：{who} 的修改清空了 {path}，或删掉了它的大半内容。之前的版本在恢复中心里。",
  "alert.too-large": "LAN Vault Sync 没有接收 {path}：它超过了本设备的接收大小上限。在设置里调高“接收文件的大小上限”即可同步它。",
  "health.title": "健康状况",
  "health.alerts": "提醒",
  "health.noPeers": "还没有交换过文件列表。",
  "health.consistent": "{name}：文件全部一致（{time} 检查）",
  "health.differing": "{name}：{count} 个文件未一致（{time} 检查）",
  "health.pending": "{name}：正在比对（{time} 检查）",
  "health.waiting": "等待 {count} 个文件",
  "health.clock": "时钟相差 {secs} 秒",
  "alert.scope-disjoint": "LAN Vault Sync：和 {peer} 之间没有任何内容可同步：本设备同步{here}，{peer} 同步{there}，两者不重叠。请在其中一台设备上修改“仅同步此文件夹”。",
  "alert.scope-missing": "LAN Vault Sync：{peer} 只同步“{folder}”文件夹，但本库里没有这个名字的文件夹。如果你的文件夹名字不同（区分大小写），请改成完全一样的名字。",
  "scope.wholeVault": "整个库",
  "scope.folder": "“{folder}”文件夹",
  "health.disconnected": "{name}：已断开 · 上次同步 {time}",
  "health.disconnectedNever": "{name}：已断开 · 还没有完整同步过",
  "health.only": "仅同步 {folder}",
  "health.tooLargeHere": "{count} 个文件未接收：超过本设备的接收大小上限",
  "health.tooLargeThere": "{count} 个文件未发送：超过 {name} 的接收大小上限",
  "health.dismiss": "知道了",
  "health.export": "导出诊断信息",
  "cmd.exportDiagnostics": "导出诊断信息（同步密钥已遮盖）",
  "notice.diagnostics": "诊断信息已保存到 {path}，同步密钥已遮盖。",
  "notice.diagnosticsCopied": "诊断信息已保存到 {path} 并已复制，同步密钥已遮盖。",
  "status.consistent": "LAN Sync：已与 {count} 台一致 · {time}",
  "status.unsynced": "LAN Sync：{count} 个文件未一致",
});
