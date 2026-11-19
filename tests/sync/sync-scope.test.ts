import { describe, expect, it } from 'vitest';
import {
  checkScope,
  inScope,
  intersectScopes,
  isLimited,
  messagePaths,
  messagePathsOf,
  normalizeSyncFolder,
} from '../../src/sync/sync-scope';
import {
  decodeMessage,
  encodeFileChunk,
  encodeFileData,
  encodeFileDelete,
  encodeFileMetaSync,
  encodeFileRename,
  encodeFileRequest,
  encodeFolderOp,
  encodeMessage,
  encodePing,
  encodePong,
  encodeYjsSync,
} from '../../src/transport/protocol';
import { MessageType } from '../../src/types';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('normalizeSyncFolder', () => {
  it('gives the whole vault for an empty or blank setting', () => {
    expect(normalizeSyncFolder('')).toBe('');
    expect(normalizeSyncFolder('   ')).toBe('');
    expect(normalizeSyncFolder('/')).toBe('');
    expect(normalizeSyncFolder(' // ')).toBe('');
  });

  it('drops surrounding white space and slashes', () => {
    expect(normalizeSyncFolder('Work')).toBe('Work');
    expect(normalizeSyncFolder('  Work  ')).toBe('Work');
    expect(normalizeSyncFolder('/Work/')).toBe('Work');
    expect(normalizeSyncFolder(' /Work/Notes/ ')).toBe('Work/Notes');
  });

  it('gives nothing for a value that is not a safe vault path', () => {
    expect(normalizeSyncFolder('..')).toBeNull();
    expect(normalizeSyncFolder('Work/../Home')).toBeNull();
    expect(normalizeSyncFolder('.obsidian')).toBeNull();
    expect(normalizeSyncFolder('Work/.hidden')).toBeNull();
    expect(normalizeSyncFolder('Work\\Notes')).toBeNull();
    expect(normalizeSyncFolder('Work//Notes')).toBeNull();
    expect(normalizeSyncFolder('C:/Work')).toBeNull();
  });

  it('gives nothing for a value that is not a string', () => {
    expect(normalizeSyncFolder(undefined)).toBeNull();
    expect(normalizeSyncFolder(null)).toBeNull();
    expect(normalizeSyncFolder(42)).toBeNull();
    expect(normalizeSyncFolder({ folder: 'Work' })).toBeNull();
  });
});

describe('isLimited', () => {
  it('is false only for the whole vault', () => {
    expect(isLimited('')).toBe(false);
    expect(isLimited('Work')).toBe(true);
    expect(isLimited(null)).toBe(true);
  });
});

describe('inScope', () => {
  it('takes the folder itself and everything in it', () => {
    expect(inScope('Work', 'Work')).toBe(true);
    expect(inScope('Work/a.md', 'Work')).toBe(true);
    expect(inScope('Work/deep/b.png', 'Work')).toBe(true);
  });

  it('does not take a folder whose name only starts the same', () => {
    expect(inScope('Workshop', 'Work')).toBe(false);
    expect(inScope('Workshop/a.md', 'Work')).toBe(false);
    expect(inScope('Home/Work/a.md', 'Work')).toBe(false);
  });

  it('tells letter case apart', () => {
    expect(inScope('work/a.md', 'Work')).toBe(false);
    expect(inScope('WORK', 'Work')).toBe(false);
  });

  it('takes everything for the whole vault and nothing for null', () => {
    expect(inScope('anything.md', '')).toBe(true);
    expect(inScope('', '')).toBe(true);
    expect(inScope('Work/a.md', null)).toBe(false);
  });

  it('does not take an empty path into a folder', () => {
    expect(inScope('', 'Work')).toBe(false);
  });
});

describe('intersectScopes', () => {
  it('keeps the other side when one is the whole vault', () => {
    expect(intersectScopes('', '')).toBe('');
    expect(intersectScopes('', 'Work')).toBe('Work');
    expect(intersectScopes('Work', '')).toBe('Work');
  });

  it('takes the deeper folder when one holds the other, either way', () => {
    expect(intersectScopes('Work', 'Work/Notes')).toBe('Work/Notes');
    expect(intersectScopes('Work/Notes', 'Work')).toBe('Work/Notes');
    expect(intersectScopes('Work', 'Work')).toBe('Work');
  });

  it('gives nothing for folders that do not overlap', () => {
    expect(intersectScopes('Work', 'Home')).toBeNull();
    expect(intersectScopes('Work', 'Workshop')).toBeNull();
    expect(intersectScopes('Work', 'work')).toBeNull();
  });

  it('gives nothing when either side is nothing', () => {
    expect(intersectScopes(null, '')).toBeNull();
    expect(intersectScopes('', null)).toBeNull();
    expect(intersectScopes('Work', null)).toBeNull();
    expect(intersectScopes(null, null)).toBeNull();
  });
});

describe('messagePaths', () => {
  const content = new Uint8Array([1, 2, 3]);

  it('reads the path of every Yjs message', () => {
    for (const type of [
      MessageType.YJS_SYNC_STEP1,
      MessageType.YJS_SYNC_STEP2,
      MessageType.YJS_UPDATE,
      MessageType.YJS_FULL_STATE,
    ] as const) {
      expect(messagePaths(encodeYjsSync(type, 'Work/a.md', content))).toEqual(['Work/a.md']);
    }
  });

  it('reads the path of file requests, data and chunks', () => {
    expect(messagePaths(encodeFileRequest('Work/a.png'))).toEqual(['Work/a.png']);
    expect(messagePaths(encodeFileData({ path: 'Work/a.png', content, mtime: 1, hash: 'h' }))).toEqual(['Work/a.png']);
    expect(
      messagePaths(encodeFileChunk({ path: 'Work/big.bin', content, mtime: 1, totalSize: 10, offset: 0, hash: 'h' })),
    ).toEqual(['Work/big.bin']);
  });

  it('reads a deletion, with where the file moved to', () => {
    expect(messagePaths(encodeFileDelete({ path: 'Work/a.md' }))).toEqual(['Work/a.md']);
    expect(messagePaths(encodeFileDelete({ path: 'Work/a.md', movedTo: 'Home/a.md' }))).toEqual([
      'Work/a.md',
      'Home/a.md',
    ]);
  });

  it('reads both sides of a rename', () => {
    expect(messagePaths(encodeFileRename({ oldPath: 'Work/a.md', newPath: 'Home/a.md' }))).toEqual([
      'Work/a.md',
      'Home/a.md',
    ]);
  });

  it('reads folder messages', () => {
    expect(messagePaths(encodeFolderOp(MessageType.FOLDER_CREATE, 'Work/new'))).toEqual(['Work/new']);
    expect(messagePaths(encodeFolderOp(MessageType.FOLDER_DELETE, 'Home/old'))).toEqual(['Home/old']);
  });

  it('gives null for messages about no single path', () => {
    expect(messagePaths(encodeFileMetaSync({ files: [] }))).toBeNull();
    expect(messagePaths(encodePing())).toBeNull();
    expect(messagePaths(encodePong())).toBeNull();
  });

  it('gives a path in no folder for a message that cannot be read', () => {
    // Too short for a header.
    expect(messagePaths(new Uint8Array([MessageType.FILE_DATA, 0]))).toEqual(['']);
    // A header that claims more payload than there is.
    expect(messagePaths(new Uint8Array([MessageType.FILE_DELETE, 0, 0, 0, 9, 1]))).toEqual(['']);
    // Payloads that do not decode.
    expect(messagePaths(encodeMessage(MessageType.FILE_DATA, new Uint8Array([0])))).toEqual(['']);
    expect(messagePaths(encodeMessage(MessageType.FILE_CHUNK, new Uint8Array([0, 5, 1])))).toEqual(['']);
    expect(messagePaths(encodeMessage(MessageType.YJS_UPDATE, new Uint8Array([0, 9, 1])))).toEqual(['']);
    expect(messagePaths(encodeMessage(MessageType.FILE_DELETE, bytes('{not json')))).toEqual(['']);
    expect(messagePaths(encodeMessage(MessageType.FILE_RENAME, bytes('[')))).toEqual(['']);
    expect(messagePaths(encodeMessage(MessageType.FOLDER_CREATE, bytes('')))).toEqual(['']);
  });

  it('gives an empty path for fields that are missing or not strings', () => {
    expect(messagePaths(encodeMessage(MessageType.FILE_DELETE, bytes('{"path":5}')))).toEqual(['']);
    expect(messagePaths(encodeMessage(MessageType.FILE_RENAME, bytes('{"oldPath":"Work/a.md"}')))).toEqual([
      'Work/a.md',
      '',
    ]);
    expect(messagePaths(encodeMessage(MessageType.FOLDER_DELETE, bytes('{}')))).toEqual(['']);
  });

  it('messagePathsOf reads a decoded message the same way', () => {
    const msg = decodeMessage(encodeFileRename({ oldPath: 'a.md', newPath: 'Work/a.md' }));
    expect(messagePathsOf(msg.type, msg.payload)).toEqual(['a.md', 'Work/a.md']);
    const ping = decodeMessage(encodePing());
    expect(messagePathsOf(ping.type, ping.payload)).toBeNull();
  });
});

describe('checkScope', () => {
  it('lets everything through on a connection that carries the whole vault', () => {
    expect(checkScope(['Home/a.md'], '')).toBe('pass');
    expect(checkScope([''], '')).toBe('pass');
  });

  it('lets messages about no single path through', () => {
    expect(checkScope(null, 'Work')).toBe('pass');
    expect(checkScope(null, null)).toBe('pass');
  });

  it('passes paths in the folder and drops ones outside it', () => {
    expect(checkScope(['Work/a.md'], 'Work')).toBe('pass');
    expect(checkScope(['Work/a.md', 'Work/b.md'], 'Work')).toBe('pass');
    expect(checkScope(['Home/a.md'], 'Work')).toBe('drop');
    expect(checkScope(['Workshop/a.md'], 'Work')).toBe('drop');
    expect(checkScope([''], 'Work')).toBe('drop');
  });

  it('calls a message across the folder edge a split', () => {
    expect(checkScope(['Work/a.md', 'Home/a.md'], 'Work')).toBe('split');
    expect(checkScope(['Home/a.md', 'Work/a.md'], 'Work')).toBe('split');
  });

  it('drops everything with a path on a connection that carries nothing', () => {
    expect(checkScope(['Work/a.md'], null)).toBe('drop');
  });
});
