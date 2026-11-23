import { afterEach, describe, expect, it } from 'vitest';
import { setConfigDir } from '../../src/constants';
import { copyLegacyState } from '../../src/utils/legacy-state';
import { MemoryAdapter } from '../diagnostics/memory-adapter';

class CopyingAdapter extends MemoryAdapter {
  async copy(a: string, b: string) {
    const v = this.files.get(a);
    if (v === undefined) throw new Error('ENOENT ' + a);
    if (this.files.has(b)) throw new Error('EEXIST ' + b);
    this.files.set(b, v);
  }
}

const OLD = '.obsidian/plugins/lan-vault-sync';
const NEW = '.config-phone/plugins/lan-vault-sync';

function oldState(): CopyingAdapter {
  const a = new CopyingAdapter();
  for (const f of ['.obsidian', '.obsidian/plugins', OLD, `${OLD}/crdt-state`, `${OLD}/conflicts`, `${OLD}/conflicts/b1`]) a.folders.add(f);
  a.files.set(`${OLD}/synced-files.json`, '{"a.md":"h1"}');
  a.files.set(`${OLD}/deleted-files.json`, '[]');
  a.files.set(`${OLD}/crdt-state/x.ystate`, 'state');
  a.files.set(`${OLD}/conflicts/b1/metadata.json`, '{}');
  a.files.set(`${OLD}/main.js`, 'code');
  a.files.set(`${OLD}/data.json`, '{"deviceId":"other"}');
  return a;
}

afterEach(() => setConfigDir('.obsidian'));

describe('copyLegacyState', () => {
  it('copies the state kept under .obsidian to a renamed config folder, and leaves the old one', async () => {
    setConfigDir('.config-phone');
    const a = oldState();
    await copyLegacyState(a as any);
    expect(a.files.get(`${NEW}/synced-files.json`)).toBe('{"a.md":"h1"}');
    expect(a.files.get(`${NEW}/deleted-files.json`)).toBe('[]');
    expect(a.files.get(`${NEW}/crdt-state/x.ystate`)).toBe('state');
    expect(a.files.get(`${NEW}/conflicts/b1/metadata.json`)).toBe('{}');
    // Not the plugin's code or settings, and nothing taken from the old folder.
    expect(a.files.has(`${NEW}/main.js`)).toBe(false);
    expect(a.files.has(`${NEW}/data.json`)).toBe(false);
    expect(a.files.get(`${OLD}/synced-files.json`)).toBe('{"a.md":"h1"}');
  });

  it('leaves a config folder that has its own state alone', async () => {
    setConfigDir('.config-phone');
    const a = oldState();
    a.folders.add(NEW);
    a.files.set(`${NEW}/synced-files.json`, '{"b.md":"h2"}');
    await copyLegacyState(a as any);
    expect(a.files.get(`${NEW}/synced-files.json`)).toBe('{"b.md":"h2"}');
    expect(a.files.has(`${NEW}/deleted-files.json`)).toBe(false);
  });

  it('does nothing where the config folder is .obsidian', async () => {
    const a = oldState();
    const before = new Map(a.files);
    await copyLegacyState(a as any);
    expect(a.files).toEqual(before);
  });
});
