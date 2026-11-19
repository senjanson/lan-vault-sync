import { describe, expect, it, vi } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { FolderSuggestModal, folderChoices, listVaultFolders } from '../../src/ui/folder-suggest-modal';
import { setLanguage } from '../../src/i18n';

function appWith(paths: Array<string | TFile>) {
  const files = paths.map((p) => (typeof p === 'string' ? new TFolder(p) : p));
  return { vault: { getAllLoadedFiles: () => files } } as any;
}

describe('choosing the folder to sync', () => {
  const app = appWith(['/', 'Work', 'Personal', 'Work/Projects', '.obsidian', '.trash/old', 'Work/.hidden', new TFile('Work/a.md')]);

  it('lists the vault’s folders, not the root, hidden folders or files', () => {
    expect(listVaultFolders(app)).toEqual(['Personal', 'Work', 'Work/Projects']);
    expect(listVaultFolders({ vault: {} } as any)).toEqual([]);
  });

  it('puts the whole vault first and passes the chosen folder on', () => {
    setLanguage('zh');
    try {
      expect(folderChoices(app).map((c) => c.label)).toEqual(['整个库（不限制）', 'Personal', 'Work', 'Work/Projects']);
    } finally {
      setLanguage(null);
    }
    const onPick = vi.fn();
    const modal = new FolderSuggestModal(app, onPick) as any;
    expect(modal.getSuggestions('proj').map((c: any) => c.path)).toEqual(['Work/Projects']);
    modal.onChooseItem(modal.getItems()[0]);
    modal.onChooseItem(modal.getItems()[2]);
    expect(onPick.mock.calls).toEqual([[''], ['Work']]);
  });
});
