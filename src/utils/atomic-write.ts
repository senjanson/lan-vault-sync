import { logger } from '../logger';

/**
 * Writing the plugin's state files so that a crash or power loss mid-save
 * never leaves a broken file in place of a good one (plan 6.1).
 *
 * A save writes the new content to `<file>.tmp` first and only then moves
 * it into place, so the file is either the old one or the new one, never
 * half of each. The previous content is kept as `<file>.bak`: the storage
 * may still lose the last write (Obsidian gives no way to flush it to
 * disk), and the backup is then what is read instead.
 */

/** The part of Obsidian's DataAdapter these helpers need. */
export interface AtomicAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  writeBinary?(path: string, data: ArrayBuffer): Promise<void>;
  remove?(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
}

export interface AtomicWriteOptions {
  /**
   * Keep the previous content as `<path>.bak` (the default). Off for files
   * that are many and cheap to lose, like a note's CRDT history, where a
   * backup would double the space taken.
   */
  backup?: boolean;
  /**
   * Whether `path` exists, when the caller already knows: on a phone each
   * lookup is a round trip, and some files are saved after every change.
   */
  exists?: boolean;
}

export const TMP_SUFFIX = '.tmp';
export const BAK_SUFFIX = '.bak';

/**
 * Saves of one file in progress, by storage. Two saves of the same file at
 * once (the app going to the background while sync stops) would share its
 * `.tmp` and fail half way, so they run one after the other, in the order
 * asked.
 */
const pending = new WeakMap<object, Map<string, Promise<void>>>();

export function writeAtomic(
  adapter: AtomicAdapter,
  path: string,
  data: string | ArrayBuffer,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  let saves = pending.get(adapter);
  if (!saves) pending.set(adapter, (saves = new Map<string, Promise<void>>()));
  const before = saves.get(path);
  // A save queued behind another can't trust what the caller knew of the
  // file: the one before may have just made it.
  const known = before ? undefined : opts.exists;
  const done = (before ?? Promise.resolve()).then(() => save(adapter, path, data, opts.backup !== false, known));
  const settled = done.catch(() => undefined);
  saves.set(path, settled);
  void settled.then(() => {
    if (saves.get(path) === settled) saves.delete(path);
  });
  return done;
}

async function save(
  adapter: AtomicAdapter,
  path: string,
  data: string | ArrayBuffer,
  backup: boolean,
  known: boolean | undefined,
): Promise<void> {
  // An adapter that cannot rename (only seen in tests) is written to in place.
  if (typeof adapter.rename !== 'function' || typeof adapter.remove !== 'function') {
    await put(adapter, path, data);
    return;
  }
  const tmp = path + TMP_SUFFIX;
  await put(adapter, tmp, data);
  const present = known ?? (await adapter.exists(path));
  if (present) {
    // Obsidian's rename fails when the destination exists, so each
    // destination is removed first.
    if (backup) {
      const bak = path + BAK_SUFFIX;
      if (await adapter.exists(bak)) await adapter.remove(bak);
      await adapter.rename(path, bak);
    } else {
      await adapter.remove(path);
    }
  }
  await adapter.rename(tmp, path);
}

function put(adapter: AtomicAdapter, path: string, data: string | ArrayBuffer): Promise<void> {
  if (typeof data === 'string') return adapter.write(path, data);
  if (typeof adapter.writeBinary !== 'function') throw new Error('this storage cannot write binary files');
  return adapter.writeBinary(path, data);
}

/**
 * Read a JSON file saved with writeAtomic. When it is missing (a crash
 * between moving the old file aside and the new one into place) or cannot
 * be read, its backup is read instead, and `onBackupUsed` is told why.
 * A leftover `.tmp` is never read: it may be half written. Null when
 * neither the file nor its backup can be read.
 */
export async function readJsonWithBackup<T>(
  adapter: AtomicAdapter,
  path: string,
  onBackupUsed?: (path: string, why: string) => void,
): Promise<T | null> {
  let why: string;
  try {
    if (await adapter.exists(path)) return JSON.parse(await adapter.read(path)) as T;
    why = 'the file was missing';
  } catch (err) {
    why = `the file was damaged (${err instanceof Error ? err.message : String(err)})`;
  }
  const bak = path + BAK_SUFFIX;
  let value: T;
  try {
    if (!(await adapter.exists(bak))) {
      // A file never saved has no backup either: nothing to warn about.
      if (why !== 'the file was missing') logger.warn(`Could not read ${path}, and it has no backup: ${why}`);
      return null;
    }
    value = JSON.parse(await adapter.read(bak)) as T;
  } catch (err) {
    logger.warn(`Could not read ${path} or its backup: ${why}; backup:`, err);
    return null;
  }
  logger.warn(`Read ${path} from its backup: ${why}`);
  try {
    onBackupUsed?.(path, why);
  } catch (err) {
    logger.warn('Could not report a state file read from its backup:', err);
  }
  return value;
}
