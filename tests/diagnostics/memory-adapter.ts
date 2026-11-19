/** In-memory stand-in for Obsidian's DataAdapter, for unit tests. */
export class MemoryAdapter {
  files = new Map<string, string | ArrayBuffer>();
  folders = new Set<string>();
  failWrites = false;
  async exists(p: string) { return this.files.has(p) || this.folders.has(p); }
  async mkdir(p: string) { this.folders.add(p); }
  async read(p: string) { const v = this.files.get(p); if (typeof v !== 'string') throw new Error('ENOENT ' + p); return v; }
  async readBinary(p: string) { const v = this.files.get(p); if (v === undefined) throw new Error('ENOENT ' + p); return typeof v === 'string' ? new TextEncoder().encode(v).buffer : v; }
  async write(p: string, d: string) { if (this.failWrites) throw new Error('EIO'); this.files.set(p, d); }
  async writeBinary(p: string, d: ArrayBuffer) { if (this.failWrites) throw new Error('EIO'); this.files.set(p, d); }
  async append(p: string, d: string) { if (this.failWrites) throw new Error('EIO'); this.files.set(p, ((this.files.get(p) as string) ?? '') + d); }
  async remove(p: string) { if (!this.files.delete(p)) throw new Error('ENOENT ' + p); }
  async rmdir(p: string) { this.folders.delete(p); }
  async rename(a: string, b: string) { const v = this.files.get(a); if (v === undefined) throw new Error('ENOENT ' + a); this.files.delete(a); this.files.set(b, v); }
  async stat(p: string) { const v = this.files.get(p); if (v === undefined) return this.folders.has(p) ? { type: 'folder', size: 0, mtime: 0, ctime: 0 } : null; const size = typeof v === 'string' ? new TextEncoder().encode(v).length : v.byteLength; return { type: 'file', size, mtime: 0, ctime: 0 }; }
  async list(p: string) {
    const pre = p ? p + '/' : '';
    const direct = (k: string) => k.startsWith(pre) && !k.slice(pre.length).includes('/');
    return { files: [...this.files.keys()].filter(direct), folders: [...this.folders].filter(direct) };
  }
}
