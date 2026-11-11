import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { YjsDocManager } from '../../src/crdt/yjs-doc-manager';

function createManager(): YjsDocManager {
  const vault = {
    adapter: {
      exists: vi.fn().mockResolvedValue(false),
      readBinary: vi.fn(),
      writeBinary: vi.fn(),
      remove: vi.fn(),
    },
  };

  return new YjsDocManager(vault as any);
}

function createUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, content);
  return Y.encodeStateAsUpdate(doc);
}

describe('YjsDocManager remote content ordering', () => {
  it('waits for async remote-content handling and allows reading updated content', async () => {
    const manager = createManager();
    const callbackDone = vi.fn();
    let callbackStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    let release!: () => void;

    manager.onRemoteContent(async (filePath, content, previousContent) => {
      expect(filePath).toBe('Untitled.md');
      expect(content).toBe('# hello');
      expect(previousContent).toBe('');
      expect(await manager.getContent(filePath)).toBe('# hello');
      callbackStarted();

      await new Promise<void>((resolve) => {
        release = resolve;
      });
      callbackDone();
    });

    let resolved = false;
    const pending = manager.applyRemoteUpdate('Untitled.md', createUpdate('# hello'));
    void pending.then(() => {
      resolved = true;
    });

    await started;
    expect(resolved).toBe(false);

    release();
    await pending;
    expect(callbackDone).toHaveBeenCalledTimes(1);
  });

  it('handleSyncStep2 also waits for async remote-content handling', async () => {
    const manager = createManager();
    const callbackDone = vi.fn();

    manager.onRemoteContent(async () => {
      await Promise.resolve();
      callbackDone();
    });

    await manager.handleSyncStep2('note.md', createUpdate('body'));

    expect(callbackDone).toHaveBeenCalledTimes(1);
    expect(await manager.getContent('note.md')).toBe('body');
  });
});

describe('YjsDocManager forwarding peer updates', () => {
  it('reports only changes that were new to the doc, with the sending device', async () => {
    const manager = createManager();
    const forwarded: Array<[string, string]> = [];
    manager.onRemoteUpdateApplied((path, _update, from) => forwarded.push([path, from]));

    const source = new Y.Doc();
    source.getText('content').insert(0, 'hello');
    const update = Y.encodeStateAsUpdate(source);

    await manager.applyRemoteUpdate('n.md', update, 'peer-a');
    // The same update again (e.g. relayed back by another peer) changes nothing.
    await manager.applyRemoteUpdate('n.md', update, 'peer-b');

    expect(forwarded).toEqual([['n.md', 'peer-a']]);
  });
});
