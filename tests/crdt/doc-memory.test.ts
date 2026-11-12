import { describe, expect, it } from 'vitest';
import { YjsDocManager } from '../../src/crdt/yjs-doc-manager';
import { MAX_ACTIVE_DOCS } from '../../src/constants';

function memoryVault() {
  const files = new Map<string, ArrayBuffer>();
  return {
    adapter: {
      exists: async (p: string) => files.has(p),
      mkdir: async () => undefined,
      readBinary: async (p: string) => files.get(p)!,
      writeBinary: async (p: string, d: ArrayBuffer) => void files.set(p, d),
      remove: async (p: string) => void files.delete(p),
      write: async () => undefined,
      read: async () => '{}',
      list: async () => ({ files: [], folders: [] }),
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('YjsDocManager memory', () => {
  it('does not keep the text of notes whose docs were unloaded', async () => {
    const manager = new YjsDocManager(memoryVault() as any) as any;
    const count = MAX_ACTIVE_DOCS * 2;
    for (let i = 0; i < count; i++) {
      await manager.initDocFromContentSilent(`n${i}.md`, `note ${i} `.repeat(50));
      await settle();
    }
    expect(manager.lastKnownContent.size).toBeLessThanOrEqual(MAX_ACTIVE_DOCS + 1);

    // An unloaded note still takes a later edit as a change to its text.
    await manager.applyLocalChange('n0.md', `note 0 `.repeat(50) + 'more');
    expect(await manager.getContent('n0.md')).toBe(`note 0 `.repeat(50) + 'more');
  });

  it('keeps the text of a note that is open in an editor', async () => {
    const manager = new YjsDocManager(memoryVault() as any) as any;
    manager.setKeepsWrittenContent((path: string) => path === 'open.md');
    await manager.initDocFromContentSilent('open.md', 'shown');
    for (let i = 0; i < MAX_ACTIVE_DOCS + 5; i++) {
      await manager.initDocFromContentSilent(`n${i}.md`, 'x');
      await settle();
    }
    expect(manager.getWrittenContent('open.md')).toBe('shown');
  });

  it('keeps the text of a note whose doc holds text not yet written', async () => {
    const manager = new YjsDocManager(memoryVault() as any) as any;
    await manager.initDocFromContentSilent('w.md', 'on disk');
    // The doc moved on (a peer's text) before the file was written.
    const doc = await manager.getOrCreateDoc('w.md');
    doc.getText('content').insert(0, 'new ');
    for (let i = 0; i < MAX_ACTIVE_DOCS + 5; i++) {
      await manager.initDocFromContentSilent(`n${i}.md`, 'x');
      await settle();
    }
    expect(manager.getWrittenContent('w.md')).toBe('on disk');
  });
});
