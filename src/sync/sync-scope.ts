/**
 * Syncing only one folder of the vault (settings.syncFolder).
 *
 * A device set to one folder syncs only the files and folders in it, and
 * its peers keep to it as well: each side says its folder in the handshake,
 * and a connection carries only what lies in both sides' folders (see
 * intersectScopes). Paths are the same on both sides: the folder must have
 * the same name on every device.
 *
 * A scope is the folder a connection or device is limited to:
 *   ""     the whole vault
 *   "Work" the folder Work and everything in it
 *   null   nothing at all (an invalid setting, or two folders that do not
 *          overlap). An invalid value never widens to the whole vault.
 */

import { decodeFileChunk, decodeFileData, decodeFileRequest, decodeJSON, decodeMessage, decodeYjsSync } from '../transport/protocol';
import { MessageType } from '../types';
import { isSafeSyncPath } from '../utils/path-utils';

export type SyncScope = string | null;

/**
 * A folder setting, or a folder a peer gave in its handshake, as a scope:
 * surrounding white space and slashes dropped; empty for the whole vault.
 * Anything that is not a string or not a safe vault path (see
 * isSafeSyncPath) gives null: nothing is synced.
 */
export function normalizeSyncFolder(raw: unknown): SyncScope {
  if (typeof raw !== 'string') return null;
  const folder = raw.trim().replace(/^\/+|\/+$/g, '').trim();
  if (folder === '') return '';
  return isSafeSyncPath(folder) ? folder : null;
}

/** Whether a scope limits sync (to a folder, or to nothing). */
export function isLimited(scope: SyncScope): boolean {
  return scope !== '';
}

/** Whether a path lies in a scope: the folder itself or anything in it. Case matters. */
export function inScope(path: string, scope: SyncScope): boolean {
  if (scope === null) return false;
  if (scope === '') return true;
  return path === scope || path.startsWith(`${scope}/`);
}

/**
 * What two devices both sync: the deeper folder when one holds the other,
 * nothing when they do not overlap.
 */
export function intersectScopes(a: SyncScope, b: SyncScope): SyncScope {
  if (a === null || b === null) return null;
  if (a === '') return b;
  if (b === '') return a;
  if (inScope(b, a)) return b;
  if (inScope(a, b)) return a;
  return null;
}

/**
 * The vault paths a message is about, or null for one about no single path
 * (file lists, pings), which goes as it is. A message whose paths cannot be
 * read gives [""], which lies in no folder.
 */
export function messagePathsOf(type: MessageType, payload: Uint8Array): string[] | null {
  try {
    switch (type) {
      case MessageType.YJS_SYNC_STEP1:
      case MessageType.YJS_SYNC_STEP2:
      case MessageType.YJS_UPDATE:
      case MessageType.YJS_FULL_STATE:
        return [decodeYjsSync(payload).filePath];
      case MessageType.FILE_REQUEST:
        return [decodeFileRequest(payload)];
      case MessageType.FILE_DATA:
        return [decodeFileData(payload).path];
      case MessageType.FILE_CHUNK:
        return [decodeFileChunk(payload).path];
      case MessageType.FILE_DELETE: {
        const p = decodeJSON<{ path?: unknown; movedTo?: unknown }>(payload);
        const paths = [typeof p.path === 'string' ? p.path : ''];
        if (typeof p.movedTo === 'string' && p.movedTo) paths.push(p.movedTo);
        return paths;
      }
      case MessageType.FILE_RENAME: {
        const p = decodeJSON<{ oldPath?: unknown; newPath?: unknown }>(payload);
        return [typeof p.oldPath === 'string' ? p.oldPath : '', typeof p.newPath === 'string' ? p.newPath : ''];
      }
      case MessageType.FOLDER_CREATE:
      case MessageType.FOLDER_DELETE: {
        const p = decodeJSON<{ path?: unknown }>(payload);
        return [typeof p.path === 'string' ? p.path : ''];
      }
      default:
        return null;
    }
  } catch {
    return [''];
  }
}

/** messagePathsOf for an encoded message ([type][length][payload]). */
export function messagePaths(data: Uint8Array): string[] | null {
  let msg: ReturnType<typeof decodeMessage>;
  try {
    msg = decodeMessage(data);
  } catch {
    return [''];
  }
  return messagePathsOf(msg.type, msg.payload);
}

/**
 * Whether a message may cross a connection limited to `scope`: "pass" when
 * all its paths lie in it (or it has none), "drop" when none do, "split"
 * when some do and some do not (a rename or move across the folder's edge).
 * A split message is dropped too; the file list exchange then settles the
 * file on both sides (a move out reads as a deletion, a move in as a new
 * file).
 */
export function checkScope(paths: string[] | null, scope: SyncScope): 'pass' | 'drop' | 'split' {
  if (paths === null || scope === '') return 'pass';
  let inside = 0;
  for (const p of paths) if (inScope(p, scope)) inside++;
  if (inside === paths.length) return 'pass';
  return inside === 0 ? 'drop' : 'split';
}
