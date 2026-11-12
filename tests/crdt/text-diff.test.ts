import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyRebasedEdit } from '../../src/crdt/text-diff';

function text(content: string): Y.Text {
  const t = new Y.Doc().getText('content');
  t.insert(0, content);
  return t;
}

describe('applyRebasedEdit', () => {
  it('keeps remote changes the editor has not seen yet', () => {
    // Editor showed "L1\nL2\nL3\n"; a peer already added " B" to line 3.
    const t = text('L1\nL2\nL3 B\n');
    applyRebasedEdit(t, 'L1\nL2\nL3\n', ' C L1\nL2\nL3\n');
    expect(t.toString()).toBe(' C L1\nL2\nL3 B\n');
  });

  it('applies deletions and replacements next to remote inserts', () => {
    const t = text('Hello brave new world');
    applyRebasedEdit(t, 'Hello world', 'Hi world!');
    expect(t.toString()).toBe('Hi brave new world!');
  });

  it('does not delete text a peer already deleted again', () => {
    const t = text('abd');
    applyRebasedEdit(t, 'abcd', 'ad');
    expect(t.toString()).toBe('ad');
  });

  it('is a plain diff when nothing changed remotely', () => {
    const t = text('one two');
    applyRebasedEdit(t, 'one two', 'one 2 three');
    expect(t.toString()).toBe('one 2 three');
  });
});
