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
  }, 'local');
}

/**
 * Apply a local edit (base → next) to a Y.Text that may already contain
 * changes the editor has not seen (ytext = base + remote changes).
 *
 * Diffing `next` against the Y.Text directly would treat the remote changes
 * missing from `next` as local deletions and drop them. Instead the edit is
 * mapped from base positions to current positions: base characters the local
 * edit deleted are deleted where they now are (unless already gone), and
 * local insertions go to the matching current position.
 */
export function applyRebasedEdit(
  ytext: Y.Text,
  base: string,
  next: string,
  origin: unknown = 'local',
): void {
  const current = ytext.toString();
  if (current === base) {
    applyDiffToYTextWithOrigin(ytext, base, next, origin);
    return;
  }
  if (base === next) return;

  // Where each base character is in `current` (-1 if a peer deleted it), and
  // where text inserted before base character i belongs in `current`.
  const at = new Int32Array(base.length + 1).fill(-1);
  const insertAt = new Int32Array(base.length + 1);
  let bi = 0;
  let ci = 0;
  for (const [op, text] of diff(base, current)) {
    if (op === diff.EQUAL) {
      for (let k = 0; k < text.length; k++) {
        insertAt[bi] = ci;
        at[bi++] = ci++;
      }
    } else if (op === diff.DELETE) {
      for (let k = 0; k < text.length; k++) insertAt[bi++] = ci;
    } else {
      ci += text.length;
    }
  }
  insertAt[base.length] = ci;

  type Edit = { pos: number; del: number; ins: string };
  const edits: Edit[] = [];
  bi = 0;
  for (const [op, text] of diff(base, next)) {
    if (op === diff.EQUAL) {
      bi += text.length;
    } else if (op === diff.INSERT) {
      edits.push({ pos: insertAt[bi], del: 0, ins: text });
    } else {
      for (let k = 0; k < text.length; k++, bi++) {
        const pos = at[bi];
        if (pos < 0) continue;
        const last = edits[edits.length - 1];
        if (last && last.ins === '' && last.pos + last.del === pos) last.del++;
        else edits.push({ pos, del: 1, ins: '' });
      }
    }
  }

  // Apply from the end so earlier positions stay valid; at the same
  // position, delete before inserting.
  edits.sort((a, b) => b.pos - a.pos || b.del - a.del);
  ytext.doc!.transact(() => {
    for (const e of edits) {
      if (e.del) ytext.delete(e.pos, e.del);
      if (e.ins) ytext.insert(e.pos, e.ins);
    }
  }, origin);
}

function applyDiffToYTextWithOrigin(ytext: Y.Text, oldText: string, newText: string, origin: unknown): void {
  if (oldText === newText) return;
  let index = 0;
  ytext.doc!.transact(() => {
    for (const [op, text] of diff(oldText, newText)) {
      if (op === diff.EQUAL) index += text.length;
      else if (op === diff.INSERT) {
        ytext.insert(index, text);
        index += text.length;
      } else ytext.delete(index, text.length);
    }
  }, origin);
}
