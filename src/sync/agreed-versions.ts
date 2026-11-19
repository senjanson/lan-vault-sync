import { AGREED_HASHES_FILE } from "../constants";
import { logger } from "../logger";
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
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Peers whose file list has not come for this long are forgotten (a reinstall gets a new device ID). */
const AGREED_PEER_TTL_MS = 90 * DAY_MS;
/** At most this many peers are remembered, the most recently seen ones. */
const MAX_AGREED_PEERS = 32;

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
  private changed = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private adapter: any,
    private onBackupUsed: (file: string, why: string) => void = () => undefined,
  ) {}

  /** The version of a file this device last had in common with a peer. */
  with(deviceId: string, path: string): string | undefined {
    return this.byPeer.get(deviceId)?.get(path);
  }

  /** A copy of the records shared with one peer. */
  snapshot(deviceId: string): Map<string, string> {
    return new Map(this.byPeer.get(deviceId) ?? []);
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

  /** A file was sent between this device and a peer: they now share it. */
  noteShared(deviceId: string, path: string, hash: string): void {
    let agreed = this.byPeer.get(deviceId);
    if (!agreed) this.byPeer.set(deviceId, (agreed = new Map()));
    if (agreed.get(path) !== hash) {
      agreed.set(path, hash);
      this.changed = true;
    }
  }

  /** A peer said when this version was made; kept when it is the earliest. */
  noteMadeAt(path: string, hash: string, at: number): void {
    const learned = this.times.get(path);
    if (!learned || learned.hash !== hash || at < learned.at) {
      this.times.set(path, { hash, at });
      this.changed = true;
    }
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
   * now shared with it. `onShared` is told of each such file.
   */
  noteLists(
    deviceId: string,
    localFiles: Map<string, FileMeta>,
    remoteFiles: Map<string, FileMeta>,
    onShared: (local: FileMeta) => void,
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
      if (agreed.get(path) === local.hash) continue;
      agreed.set(path, local.hash);
      this.changed = true;
    }
    // A file the peer no longer lists has no version it would name for it.
    for (const path of agreed.keys()) {
      if (remoteFiles.has(path)) continue;
      agreed.delete(path);
      this.changed = true;
    }
    for (const records of this.byPeer.values()) {
      for (const path of records.keys()) {
        if (localFiles.has(path)) continue;
        records.delete(path);
        this.changed = true;
      }
    }
    for (const path of this.times.keys()) {
      if (localFiles.has(path)) continue;
      this.times.delete(path);
      this.changed = true;
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
      this.byPeer.delete(peer);
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
    const ids = [...this.byPeer.keys()];
    const files: SavedAgreedHashes["files"] = {};
    const paths = new Set<string>();
    for (const records of this.byPeer.values()) for (const path of records.keys()) paths.add(path);
    for (const path of paths) {
      const hashes = ids.map((id) => this.byPeer.get(id)!.get(path) ?? null);
      files[path] = hashes.every((h) => h !== null && h === hashes[0]) ? hashes[0]! : hashes;
    }
    const times: SavedAgreedHashes["times"] = {};
    for (const [path, { hash, at }] of this.times) times[path] = [hash, at];
    return {
      version: 2,
      peers: ids.map((id) => ({ id, seen: this.peerSeen.get(id) ?? Date.now() })),
      files,
      times,
    };
  }

  /** Saves run one after another, so an older list never overwrites a newer one. */
  save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      if (!this.adapter || !this.changed) return;
      this.changed = false;
      try {
        await ensureParentDirectory(this.adapter, AGREED_HASHES_FILE);
        await writeAtomic(this.adapter, AGREED_HASHES_FILE, JSON.stringify(this._toSave()));
      } catch (err) {
        this.changed = true;
        logger.warn("Could not save the versions last shared with peers:", err);
      }
    });
    return this.saving;
  }
}
