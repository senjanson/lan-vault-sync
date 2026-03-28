import diff from 'fast-diff';
import * as Y from 'yjs';

/**
 * Apply the diff between oldText and newText to a Y.Text instance.
 * This preserves CRDT history by only inserting/deleting the changed parts.
 */
export function applyDiffToYText(ytext: Y.Text, oldText: string, newText: string): void {
  if (oldText === newText) return;

  const diffs = diff(oldText, newText);
  let index = 0;

  ytext.doc!.transact(() => {
    for (const [op, text] of diffs) {
      switch (op) {
        case diff.EQUAL:
          index += text.length;
          break;
        case diff.INSERT:
          ytext.insert(index, text);
          index += text.length;
          break;
        case diff.DELETE:
          ytext.delete(index, text.length);
          break;
      }
    }
  });
}
