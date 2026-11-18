/**
 * Holds bulk deletions until the user decides (plan 3.3):
 *
 * - Deletions inferred from files missing since sync last ran: more than
 *   20 in one file-list exchange, or more than 5% of the vault (and at
 *   least 10 files, so that a small vault's few deletions go through), are
 *   held.
 *   Nothing is recorded or sent, and the files are not fetched back either.
 * - Deletions from a peer (live or from its file list): once one peer's
 *   deletions within two minutes would pass half of the vault (and at least
 *   10 files), the rest are held. A move is not counted: nothing is lost.
 */
import type { FileDeletePayload, FileMeta, Tombstone } from "../types";

export const INFERRED_MAX = 20;
export const INFERRED_SHARE = 0.05;
export const INCOMING_SHARE = 0.5;
export const INCOMING_MIN = 10;
/** Fewer inferred deletions than this are never held for their share. */
export const INFERRED_MIN = 10;
export const INCOMING_WINDOW_MS = 2 * 60 * 1000;

export interface DeleteLimits {
  inferredMax: number;
  inferredShare: number;
  inferredMin: number;
  incomingShare: number;
  incomingMin: number;
  windowMs: number;
}

export const DEFAULT_DELETE_LIMITS: DeleteLimits = {
  inferredMax: INFERRED_MAX,
  inferredShare: INFERRED_SHARE,
  inferredMin: INFERRED_MIN,
  incomingShare: INCOMING_SHARE,
  incomingMin: INCOMING_MIN,
  windowMs: INCOMING_WINDOW_MS,
};

/** One held deletion, with what is needed to apply it later. */
export interface HeldItem {
  path: string;
  /** A peer's live deletion message. */
  del?: FileDeletePayload;
  /** A deletion from a peer's file list: its record, and our hash then. */
  tree?: { record: Tombstone; expectHash: string };
  /** A file found missing here (inferred deletion). */
  file?: FileMeta;
}

export interface HeldDeletion {
  id: string;
  kind: "inferred" | "incoming";
  /** The peer the deletions came from (incoming). */
  deviceId?: string;
  peer?: string;
  since: number;
  paths: string[];
}

interface Batch extends Omit<HeldDeletion, "paths"> {
  items: Map<string, HeldItem>;
}

export class DeleteBreaker {
  private batches = new Map<string, Batch>();
  private recent = new Map<string, number[]>();
  private nextId = 1;

  private limits: DeleteLimits;

  constructor(
    private vaultCount: () => number,
    private now: () => number = Date.now,
    limits: Partial<DeleteLimits> = {},
  ) {
    this.limits = { ...DEFAULT_DELETE_LIMITS, ...limits };
  }

  /** Whether `count` inferred deletions in one round are too many to make unasked. */
  holdsInferred(count: number): boolean {
    if (count === 0) return false;
    const vaultSize = this.vaultCount() + count;
    const l = this.limits;
    return count > l.inferredMax || (count >= l.inferredMin && count > vaultSize * l.inferredShare);
  }

  inferredBatch(): Batch | undefined {
    return this.batches.get("inferred");
  }

  isHeldInferred(path: string): boolean {
    return !!this.batches.get("inferred")?.items.has(path);
  }

  /** Holds these inferred deletions (added to the batch already held). */
  holdInferred(items: HeldItem[]): Batch {
    let batch = this.batches.get("inferred");
    if (!batch) {
      batch = { id: `held-${this.nextId++}`, kind: "inferred", since: this.now(), items: new Map() };
      this.batches.set("inferred", batch);
    }
    for (const item of items) {
      // Already held as a peer's deletion: one decision for one file.
      if (![...this.batches.values()].some((b) => b !== batch && b.items.has(item.path))) batch.items.set(item.path, item);
    }
    if (batch.items.size === 0) this.batches.delete("inferred");
    return batch;
  }

  /**
   * Whether a peer's deletion may be applied now. When not, it is added to
   * that peer's held batch; `created` tells whether the batch is new.
   */
  admit(deviceId: string, item: HeldItem, peer?: string): { ok: true } | { ok: false; batch: Batch; created: boolean } {
    // A move: the note lives on under its new name, and nothing is lost.
    // Held, a folder of notes moved on one device asked the user on every
    // other one, and waited even after the moved notes arrived.
    if (item.del?.movedTo || item.tree?.record.movedTo) return { ok: true };
    // The same deletion already waits for the user, held from another
    // device or found here: passed on by this one, it waits too. Counted
    // per device, it would have gone under that device's threshold.
    for (const batch of this.batches.values()) {
      if (batch.items.has(item.path)) return { ok: false, batch, created: false };
    }
    const key = `incoming\n${deviceId}`;
    const held = this.batches.get(key);
    if (held) {
      held.items.set(item.path, item);
      return { ok: false, batch: held, created: false };
    }
    const now = this.now();
    const times = (this.recent.get(deviceId) ?? []).filter((t) => now - t < this.limits.windowMs);
    const vaultSize = this.vaultCount() + times.length;
    const count = times.length + 1;
    if (count >= this.limits.incomingMin && count > vaultSize * this.limits.incomingShare) {
      const batch: Batch = { id: `held-${this.nextId++}`, kind: "incoming", deviceId, peer, since: now, items: new Map([[item.path, item]]) };
      this.batches.set(key, batch);
      this.recent.set(deviceId, times);
      return { ok: false, batch, created: true };
    }
    times.push(now);
    this.recent.set(deviceId, times);
    return { ok: true };
  }

  list(): HeldDeletion[] {
    return [...this.batches.values()].map((b) => ({
      id: b.id,
      kind: b.kind,
      deviceId: b.deviceId,
      peer: b.peer,
      since: b.since,
      paths: [...b.items.keys()].sort(),
    }));
  }

  /** Takes a batch out to be resolved. */
  take(id: string): Batch | undefined {
    for (const [key, batch] of this.batches) {
      if (batch.id !== id) continue;
      this.batches.delete(key);
      if (batch.deviceId) this.recent.delete(batch.deviceId);
      return batch;
    }
    return undefined;
  }

  /** Drops held items whose files were dealt with otherwise. */
  forget(path: string): void {
    for (const [key, batch] of this.batches) {
      batch.items.delete(path);
      if (batch.items.size === 0) this.batches.delete(key);
    }
  }
}
