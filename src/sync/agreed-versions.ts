import { AGREED_HASHES_FILE } from "../constants";
import { logger } from "../logger";
import type { DataAdapter } from "obsidian";
import type { FileMeta } from "../types";
import { readJsonWithBackup, writeAtomic } from "../utils/atomic-write";
import { ensureParentDirectory } from "../utils/path-utils";

/** AGREED_HASHES_FILE; see AgreedVersions.toSave. */
interface SavedAgreedHashes {
  version: 2;
  /** Peers by device ID, and when each last sent its file list. */
  peers: Array<{ id: string; seen: number }>;
  /** Per note: the hash shared with every peer, or one per peer (null: none). */
  files: Record<string, string | Array<string | null>>;
  /** Per note: an earlier time learned for its current version; see FileMeta.madeAt. */
  times: Record<string, [string, number]>;
  /** Per file: the peers (by index in `peers`) whose record it changed from; see AgreedVersions.confirmed. */
  changed?: Record<string, number[]>;
  /** [peer index in `peers`, path, hashes]: attachment versions sent and not yet confirmed; see AgreedVersions.sent. */
  sent?: Array<[number, string, string[]]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Peers whose file list has not come for this long are forgotten (a reinstall gets a new device ID). */
const AGREED_PEER_TTL_MS = 90 * DAY_MS;
/** At most this many peers are remembered, the most recently seen ones. */
const MAX_AGREED_PEERS = 32;
/**
 * How long a change made outside a file list exchange (a file received, a
 * change here) waits before the records are written: a first sync receives
 * files by the thousand, and each write rewrites the whole file. A phone's
 * app is often killed without notice, and a version received but not saved
 * was not known as shared after the restart, so its old copy came back.
 */
const SAVE_DELAY_MS = 1000;
/** While changes keep coming, writes take a tenth of the time at most, up to this long apart. */
const MAX_SAVE_DELAY_MS = 3000;
/** At most this many versions of one file sent to one peer are remembered, the latest ones. */
const MAX_SENT_PER_FILE = 8;

/** A time in a peer's file list that can be compared with ours. */
export function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Per peer and file: the version (hash) this device and that peer last had
 * in common, as each saw the other list it or a file was sent between them.
 * Lets two devices whose histories no longer match tell a file changed on
 * one side only from one changed on both. Also the earliest time known for
 * each file's current version (FileMeta.madeAt). Saved to AGREED_HASHES_FILE.
 *
 * Kept per peer: with one record per file, a list exchange with one device
 * moved it on to a version another device, away meanwhile, never had; the
 * two then named different versions and the file was settled by modified
 * times, which kept a needless conflict copy.
 */
export class AgreedVersions {
  private byPeer = new Map<string, Map<string, string>>();
  /** When each peer last sent its file list, to forget devices gone for good. */
  private peerSeen = new Map<string, number>();
  /** Earlier times for files' current versions (path → hash and time). */
  private times = new Map<string, { hash: string; at: number }>();
  /**
   * Per file: the peers whose record our copy has changed from since it was
   * made, changed here or by another peer's version (see confirmed).
   */
  private changedSince = new Map<string, Set<string>>();
  /**
   * Per peer and attachment: versions sent to that peer that it has not
   * confirmed (by listing the file, or sending it back). A peer records a
   * version it got only a moment later (see SAVE_DELAY_MS), and a phone's
   * app killed meanwhile lost that record: it still had the copy, but
   * neither side knew it as a version the two shared, so when the file was
   * changed and deleted here, the old copy came back from it. These go
   * with a deletion of the file (see Tombstone.older and sentVersions).
   */
  private sent = new Map<string, Map<string, string[]>>();
  private changed = false;
  private saving: Promise<void> = Promise.resolve();
  private saveTimer: number | null = null;
  /** How long the last write took, in ms. */
  private lastWriteMs = 0;
  /** Set by close(): nothing is written later, from a timer, once sync stopped. */
  private closed = false;

  constructor(
    private adapter: DataAdapter,
    private onBackupUsed: (file: string, why: string) => void = () => undefined,
  ) {}

  /** The version of a file this device last had in common with a peer. */
  with(deviceId: string, path: string): string | undefined {
    return this.byPeer.get(deviceId)?.get(path);
  }

  /**
   * The version of a file this device last had in common with a peer, when
   * our copy has not changed since, even to come back to that version: then
   * it was neither changed here nor replaced by another peer's version after
   * the two had it in common. A file changed here and sent to the peer is
   * only recorded as shared once the peer is known to have it (it lists it,
   * or sends it back), so a change the peer refused, or has not received,
   * never counts as that version.
   */
  confirmed(deviceId: string, path: string): string | undefined {
    if (this.changedSince.get(path)?.has(deviceId)) return undefined;
    return this.with(deviceId, path);
  }

  /** A copy of the records shared with one peer, as confirmed() gives them. */
  snapshot(deviceId: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const [path, hash] of this.byPeer.get(deviceId) ?? []) {
      if (!this.changedSince.get(path)?.has(deviceId)) out.set(path, hash);
    }
    return out;
  }

  /**
   * Our copy of a file changed (here, or put back after a deletion): no
   * peer's record of it is confirmed until that peer has the copy too.
   */
  noteChanged(path: string): void {
    for (const [deviceId, agreed] of this.byPeer) {
      if (agreed.has(path)) this._markChanged(deviceId, path);
    }
    this._scheduleSave();
  }

  private _markChanged(deviceId: string, path: string): void {
    let peers = this.changedSince.get(path);
    if (!peers) this.changedSince.set(path, (peers = new Set()));
    if (peers.has(deviceId)) return;
    peers.add(deviceId);
    this.changed = true;
  }

  /** The record for this peer and file is confirmed again (or gone). */
  private _clearChanged(deviceId: string, path: string): void {
    const peers = this.changedSince.get(path);
    if (!peers?.delete(deviceId)) return;
    if (peers.size === 0) this.changedSince.delete(path);
    this.changed = true;
  }

  /** The records shared with one peer, unchanged; for building its file list. */
  forPeer(deviceId: string): ReadonlyMap<string, string> | undefined {
    return this.byPeer.get(deviceId);
  }

  /** Any peer's record for this file, if there is one. */
  anyFor(path: string): string | undefined {
    for (const agreed of this.byPeer.values()) {
      const hash = agreed.get(path);
      if (hash) return hash;
    }
    return undefined;
  }

  /** Whether some peer had this very version, or gave a time for it. */
  sharedWithSomeone(path: string, hash: string): boolean {
    if (this.times.get(path)?.hash === hash) return true;
    for (const agreed of this.byPeer.values()) if (agreed.get(path) === hash) return true;
    return false;
  }

  /**
   * An attachment version was sent to a peer, which may have it from now on
   * whether or not it records that (see `sent`).
   */
  noteSent(deviceId: string, path: string, hash: string): void {
    if (!hash) return;
    let files = this.sent.get(deviceId);
    if (!files) this.sent.set(deviceId, (files = new Map()));
    const hashes = (files.get(path) ?? []).filter((h) => h !== hash);
    hashes.push(hash);
    files.set(path, hashes.slice(-MAX_SENT_PER_FILE));
    this.changed = true;
    this._scheduleSave();
  }

  /**
   * The versions of an attachment sent to peers and not confirmed by them,
   * oldest first: a peer may hold any of them without knowing it shares it.
   */
  sentVersions(path: string): string[] {
    const out: string[] = [];
    for (const files of this.sent.values()) {
      for (const h of files.get(path) ?? []) if (!out.includes(h)) out.push(h);
    }
    return out;
  }

  private _forgetSent(deviceId: string, path: string): void {
    const files = this.sent.get(deviceId);
    if (!files?.delete(path)) return;
    if (files.size === 0) this.sent.delete(deviceId);
    this.changed = true;
  }

  /**
   * A peer's version of a file was received and is now our copy: we share
   * it with that peer. Called on receipt only, never when we send: what we
   * send may be refused. Our copy moved on from what other peers had.
   */
  noteShared(deviceId: string, path: string, hash: string): void {
    let agreed = this.byPeer.get(deviceId);
    if (!agreed) this.byPeer.set(deviceId, (agreed = new Map<string, string>()));
    if (agreed.get(path) !== hash) {
      agreed.set(path, hash);
      this.changed = true;
    }
    this._clearChanged(deviceId, path);
    // What we sent the peer before is no longer its copy: this is.
    this._forgetSent(deviceId, path);
    for (const [other, records] of this.byPeer) {
      const theirs = records.get(path);
      if (other !== deviceId && theirs !== undefined && theirs !== hash) this._markChanged(other, path);
    }
    this._scheduleSave();
  }

  /** A peer said when this version was made; kept when it is the earliest. */
  noteMadeAt(path: string, hash: string, at: number): void {
    const learned = this.times.get(path);
    if (!learned || learned.hash !== hash || at < learned.at) {
      this.times.set(path, { hash, at });
      this.changed = true;
      this._scheduleSave();
    }
  }

  /** Write the records soon; see SAVE_DELAY_MS. A save made meanwhile takes the change with it. */
  private _scheduleSave(): void {
    if (!this.adapter || !this.changed || this.closed || this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, Math.min(MAX_SAVE_DELAY_MS, Math.max(SAVE_DELAY_MS, this.lastWriteMs * 10)));
  }

  /**
   * When the version of a file with this content was made: its modified
   * time, or an earlier time a peer gave for the same content. One learned
   * for content we no longer have does not apply to any other.
   */
  madeAt(path: string, hash: string, mtime: number): number {
    const learned = this.times.get(path);
    if (learned && learned.hash !== hash) {
      this.times.delete(path);
      this.changed = true;
      return mtime;
    }
    return learned ? Math.min(learned.at, mtime) : mtime;
  }

  /**
   * A peer's file list came: every file listed the same on both sides is
   * now shared with it. `onShared` is told of each such file. `deleted`:
   * the files the peer lists as deleted; see below.
   */
  noteLists(
    deviceId: string,
    localFiles: Map<string, FileMeta>,
    remoteFiles: Map<string, FileMeta>,
    onShared: (local: FileMeta) => void,
    deleted: ReadonlySet<string> = new Set(),
  ): void {
    let agreed = this.byPeer.get(deviceId);
    if (!agreed) {
      agreed = new Map();
      this.byPeer.set(deviceId, agreed);
    }
    for (const [path, remote] of remoteFiles) {
      const local = localFiles.get(path);
      if (!local || local.isTextFile !== remote.isTextFile || local.hash !== remote.hash) continue;
      onShared(local);
      const madeAt = local.madeAt ?? local.mtime;
      if (isTime(remote.madeAt) && remote.madeAt < madeAt) {
        this.times.set(path, { hash: local.hash, at: remote.madeAt });
        this.changed = true;
      }
      // Both have this copy now, whatever happened to it before.
      this._clearChanged(deviceId, path);
      this._forgetSent(deviceId, path);
      if (agreed.get(path) === local.hash) continue;
      agreed.set(path, local.hash);
      this.changed = true;
    }
    // A file the peer no longer lists has no version it would name for it.
    // Except an attachment the peer deleted that is still here: the record
    // is the version the two had before the deletion, which decides whether
    // our copy goes too (see TombstoneStore.covers), and our file list tells
    // the peer (FileMeta.agreed), so that it does not fetch our copy back
    // meanwhile: the deletion may wait for the user here, and our list may
    // be made after this one is taken in. It goes with our copy (below).
    for (const path of agreed.keys()) {
      if (remoteFiles.has(path)) continue;
      if (deleted.has(path) && localFiles.get(path)?.isTextFile === false) continue;
      agreed.delete(path);
      this._clearChanged(deviceId, path);
      this.changed = true;
    }
    for (const [peer, records] of this.byPeer) {
      for (const path of records.keys()) {
        if (localFiles.has(path)) continue;
        records.delete(path);
        this._clearChanged(peer, path);
        this.changed = true;
      }
    }
    for (const path of this.times.keys()) {
      if (localFiles.has(path)) continue;
      this.times.delete(path);
      this.changed = true;
    }
    // A file gone here took the versions sent with its deletion record, if
    // it needed them; one the peer does not list it does not have.
    for (const [peer, files] of this.sent) {
      for (const path of files.keys()) {
        if (localFiles.has(path) && (peer !== deviceId || remoteFiles.has(path))) continue;
        this._forgetSent(peer, path);
      }
    }
    // Only a day's precision is needed (see _forgetOldPeers); a save at
    // every exchange would not be.
    const now = Date.now();
    if (now - (this.peerSeen.get(deviceId) ?? 0) > DAY_MS) {
      this.peerSeen.set(deviceId, now);
      this.changed = true;
    }
    this._forgetOldPeers();
    // Saved right away: the app may be closed without notice before the
    // next save, and a version recorded later is lost with it.
    if (this.changed) void this.save();
  }

  /**
   * Forget the versions shared with peers not seen for long. Such a peer
   * coming back settles files changed on both sides by time again, keeping
   * a conflict copy, as before these records existed.
   */
  private _forgetOldPeers(): void {
    const now = Date.now();
    const bySeen = [...this.byPeer.keys()].sort((a, b) => (this.peerSeen.get(b) ?? 0) - (this.peerSeen.get(a) ?? 0));
    bySeen.forEach((peer, i) => {
      if (i < MAX_AGREED_PEERS && now - (this.peerSeen.get(peer) ?? 0) <= AGREED_PEER_TTL_MS) return;
      for (const path of this.byPeer.get(peer)!.keys()) this._clearChanged(peer, path);
      this.byPeer.delete(peer);
      if (this.sent.delete(peer)) this.changed = true;
      this.peerSeen.delete(peer);
      this.changed = true;
    });
  }

  /**
   * Read the saved records. A file in the earlier form (one hash per note,
   * {path: hash}, from test builds) is ignored: it does not say which peer a
   * version was shared with, which is the very thing that was wrong with it.
   * The records are made again at the next file list exchange with each peer.
   */
  async load(): Promise<void> {
    this.closed = false;
    try {
      if (!this.adapter) return;
      const saved = await readJsonWithBackup<Partial<SavedAgreedHashes>>(this.adapter, AGREED_HASHES_FILE, this.onBackupUsed);
      if (saved?.version !== 2 || !Array.isArray(saved.peers)) return;
      const peers: Array<Map<string, string> | null> = saved.peers.map((p) => {
        if (!p || typeof p.id !== "string" || !isTime(p.seen)) return null;
        const records = new Map<string, string>();
        this.byPeer.set(p.id, records);
        this.peerSeen.set(p.id, p.seen);
        return records;
      });
      for (const [path, hashes] of Object.entries(saved.files ?? {})) {
        peers.forEach((records, i) => {
          const hash = typeof hashes === "string" ? hashes : Array.isArray(hashes) ? hashes[i] : null;
          if (records && typeof hash === "string") records.set(path, hash);
        });
      }
      for (const [path, time] of Object.entries(saved.times ?? {})) {
        if (Array.isArray(time) && typeof time[0] === "string" && isTime(time[1])) {
          this.times.set(path, { hash: time[0], at: time[1] });
        }
      }
      for (const entry of Array.isArray(saved.sent) ? saved.sent : []) {
        if (!Array.isArray(entry)) continue;
        const [i, path, hashes] = entry;
        const peer = typeof i === "number" ? saved.peers[i]?.id : undefined;
        if (typeof peer !== "string" || !this.byPeer.has(peer) || typeof path !== "string" || !Array.isArray(hashes)) continue;
        const kept = hashes.filter((h): h is string => typeof h === "string" && h !== "").slice(-MAX_SENT_PER_FILE);
        if (kept.length === 0) continue;
        let files = this.sent.get(peer);
        if (!files) this.sent.set(peer, (files = new Map()));
        files.set(path, kept);
      }
      for (const [path, indexes] of Object.entries(saved.changed ?? {})) {
        if (!Array.isArray(indexes)) continue;
        for (const i of indexes) {
          const peer = typeof i === "number" ? saved.peers[i]?.id : undefined;
          if (typeof peer === "string" && this.byPeer.get(peer)?.has(path)) this._markChanged(peer, path);
        }
      }
      this._forgetOldPeers();
    } catch (err) {
      logger.warn("Could not read the versions last shared with peers:", err);
    }
  }

  /**
   * The records in the form saved: a file's hash is written once when every
   * peer has the same one (the usual case), so the file is no larger than
   * one record per file; otherwise one entry per peer, in the order of
   * `peers`, null where there is none.
   */
  private _toSave(): SavedAgreedHashes {
    // A peer we only sent to is listed too, with no records of its own.
    const ids = [...new Set([...this.byPeer.keys(), ...this.sent.keys()])];
    const files: SavedAgreedHashes["files"] = {};
    const paths = new Set<string>();
    for (const records of this.byPeer.values()) for (const path of records.keys()) paths.add(path);
    for (const path of paths) {
      const hashes = ids.map((id) => this.byPeer.get(id)?.get(path) ?? null);
      files[path] = hashes.every((h) => h !== null && h === hashes[0]) ? hashes[0]! : hashes;
    }
    const times: SavedAgreedHashes["times"] = {};
    for (const [path, { hash, at }] of this.times) times[path] = [hash, at];
    const saved: SavedAgreedHashes = {
      version: 2,
      peers: ids.map((id) => ({ id, seen: this.peerSeen.get(id) ?? Date.now() })),
      files,
      times,
    };
    // Left out when empty (the usual case); older versions ignore it.
    if (this.changedSince.size > 0) {
      saved.changed = {};
      for (const [path, peers] of this.changedSince) {
        saved.changed[path] = [...peers].map((id) => ids.indexOf(id)).filter((i) => i >= 0);
      }
    }
    // Left out when empty too (the usual case).
    if (this.sent.size > 0) {
      saved.sent = [];
      for (const [peer, files] of this.sent) {
        const i = ids.indexOf(peer);
        for (const [path, hashes] of files) saved.sent.push([i, path, hashes]);
      }
    }
    return saved;
  }

  /** Write what is pending and schedule no more writes, until load(). */
  close(): Promise<void> {
    this.closed = true;
    return this.save();
  }

  /**
   * Saves run one after another, so an older list never overwrites a newer
   * one. A save waiting its turn (see _scheduleSave) is not needed after this.
   */
  save(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saving = this.saving.then(async () => {
      if (!this.adapter || !this.changed) return;
      this.changed = false;
      try {
        await ensureParentDirectory(this.adapter, AGREED_HASHES_FILE);
        const started = Date.now();
        await writeAtomic(this.adapter, AGREED_HASHES_FILE, JSON.stringify(this._toSave()));
        this.lastWriteMs = Date.now() - started;
      } catch (err) {
        this.changed = true;
        logger.warn("Could not save the versions last shared with peers:", err);
      }
    });
    return this.saving;
  }
}
