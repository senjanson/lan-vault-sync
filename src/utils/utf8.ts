const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Whether a text file's bytes come back unchanged when read as a string and
 * written again: valid UTF-8 without a byte order mark. Text that is not
 * (another encoding, or a BOM, which reading drops) is synced as bytes, like
 * an attachment; every device decides this from the same bytes.
 */
export function isPlainUtf8(bytes: Uint8Array): boolean {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return false;
  try {
    strictDecoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** How many bytes a string takes as UTF-8. */
export function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        i++;
      } else {
        length += 3;
      }
    } else length += 3;
  }
  return length;
}
