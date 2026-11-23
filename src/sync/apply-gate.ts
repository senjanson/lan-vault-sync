/**
 * The one way content leaves this device's vault for a peer's sake: a
 * deletion, an overwrite, a rename onto an existing file. Each step runs in
 * a fixed order:
 *
 *  1. check the precondition: the file is still what the decision saw;
 *     otherwise nothing happens, it is logged and the file lists are
 *     compared again;
 *  2. keep the old version (see VersionKeeper);
 *  3. make the change;
 *  4. log what was done, by which rule, and where the old version is.
 */
import { TAbstractFile, TFile, Vault } from "obsidian";
import { computeFileHash } from "../binary-sync/file-hash";
import { ConflictBackupService } from "../conflict/conflict-backup-service";
import { EventLog, LogOp } from "../diagnostics/event-log";
import { logger } from "../logger";

export type GateResult = "applied" | "precondition-failed" | "held" | "failed";

export interface OpContext {
  /** Peer the change came from, as "deviceId (name)". */
  peer?: string;
  /** The rule that decided it, e.g. "tombstone-covers". */
  rule: string;
  batch?: string;
}

/** Where an old version is kept before it is replaced or deleted. */
export interface VersionKeeper {
  /** Returns an id to find the version by, or null when it could not be kept. */
  keep(
    path: string,
    content: Uint8Array,
    reason: string,
    ctx: OpContext,
  ): Promise<{ id: string; hash?: string } | null>;
}

/** Keeps versions with the conflict backups, as before the version store. */
export class BackupKeeper implements VersionKeeper {
  constructor(private backups: ConflictBackupService) {}
  async keep(path: string, content: Uint8Array, reason: string): Promise<{ id: string } | null> {
    const backup = await this.backups.backupBinaryFile(path, content, reason, { size: content.byteLength });
    return backup ? { id: backup.backupId } : null;
  }
}

export interface ApplyGateDeps {
  vault: Vault;
  keeper: VersionKeeper;
  log: EventLog;
  /** Moves a file to the trash the user chose (Obsidian's fileManager.trashFile). */
  trash: (file: TAbstractFile) => Promise<void>;
  /** A precondition failed: the file lists should be compared again. */
  onPreconditionFailed?: (path: string) => void;
  /** Keeping the old version failed, and the change was not made. */
  onKeepFailed?: (path: string, op: string) => void;
}

export class ApplyGate {
  constructor(private deps: ApplyGateDeps) {}

  get log(): EventLog {
    return this.deps.log;
  }

  /** Reads a file's bytes and hash, or null when it is not a file. */
  async snapshot(path: string): Promise<{ file: TFile; bytes: Uint8Array; hash: string } | null> {
    const file = this.deps.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const bytes = new Uint8Array(await this.deps.vault.readBinary(file));
    return { file, bytes, hash: await computeFileHash(toArrayBuffer(bytes)) };
  }

  /** Step 1 failed: log it and have the file lists compared again. */
  preconditionFailed(
    op: LogOp,
    path: string,
    ctx: OpContext,
    expected: string | undefined,
    actual: { hash?: string; size?: number } | null,
    why: string,
  ): GateResult {
    this.deps.log.record({
      op: "precondition-failed",
      level: "warn",
      path,
      peer: ctx.peer,
      rule: ctx.rule,
      batch: ctx.batch,
      before: actual ?? undefined,
      msg: `${op} skipped: ${why}${expected ? ` (expected ${expected.slice(0, 12)})` : ""}`,
    });
    this.deps.onPreconditionFailed?.(path);
    return "precondition-failed";
  }

  /** Step 2: keep the old version; null (logged) when that failed. */
  async keepOld(
    path: string,
    bytes: Uint8Array,
    reason: string,
    ctx: OpContext,
  ): Promise<{ id: string; hash?: string } | null> {
    let kept: { id: string; hash?: string } | null = null;
    try {
      kept = await this.deps.keeper.keep(path, bytes, reason, ctx);
    } catch (err) {
      logger.debug(`Keeping the old version of ${path} failed:`, err);
    }
    if (!kept) {
      this.deps.log.record({
        op: "error",
        level: "error",
        path,
        peer: ctx.peer,
        rule: ctx.rule,
        batch: ctx.batch,
        msg: `${reason}: could not keep the old version; nothing was changed`,
      });
      this.deps.onKeepFailed?.(path, reason);
    }
    return kept;
  }

  /** Step 4. */
  applied(
    op: LogOp,
    path: string,
    ctx: OpContext,
    before?: { hash?: string; size?: number },
    after?: { hash?: string; size?: number },
    version?: string,
    msg?: string,
  ): void {
    this.deps.log.record({ op, path, peer: ctx.peer, rule: ctx.rule, batch: ctx.batch, before, after, version, msg });
  }

  failed(op: string, path: string, ctx: OpContext, err: unknown): GateResult {
    this.deps.log.record({
      op: "error",
      level: "error",
      path,
      peer: ctx.peer,
      rule: ctx.rule,
      batch: ctx.batch,
      error: err instanceof Error ? err.message : String(err),
      msg: `${op} failed`,
    });
    return "failed";
  }

  /** Removes a file or folder, to the trash the user chose. */
  async remove(file: TAbstractFile): Promise<void> {
    await this.deps.trash(file);
  }
}

export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}
