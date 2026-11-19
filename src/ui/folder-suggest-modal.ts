import { App, FuzzySuggestModal, TFolder } from "obsidian";
import { t } from "../i18n";

/** A choice in the folder list: a folder's path, or "" for the whole vault. */
export interface FolderChoice {
  path: string;
  label: string;
}

/**
 * The vault's folders that sync can be limited to, sorted: not the root,
 * and none with a part that starts with a dot (.obsidian, .trash, the
 * plugin's own .lan-vault-sync), which are never synced.
 */
export function listVaultFolders(app: App): string[] {
  const all = (app.vault as { getAllLoadedFiles?(): unknown[] }).getAllLoadedFiles?.() ?? [];
  const folders: string[] = [];
  for (const f of all) {
    if (!(f instanceof TFolder) || f.isRoot()) continue;
    const path = f.path.replace(/^\/+|\/+$/g, "");
    if (!path || path.split("/").some((part) => part.startsWith("."))) continue;
    folders.push(path);
  }
  return folders.sort((a, b) => a.localeCompare(b));
}

/** The choices the folder picker lists: the whole vault first, then each folder. */
export function folderChoices(app: App): FolderChoice[] {
  return [{ path: "", label: t("set.syncFolderNoLimit") }, ...listVaultFolders(app).map((path) => ({ path, label: path }))];
}

/**
 * Pick the folder to sync, or the whole vault. One list to type into and
 * pick from, the same on a computer and a phone.
 */
export class FolderSuggestModal extends FuzzySuggestModal<FolderChoice> {
  constructor(
    app: App,
    private onPick: (path: string) => void,
  ) {
    super(app);
    this.setPlaceholder(t("set.syncFolderFind"));
  }

  getItems(): FolderChoice[] {
    return folderChoices(this.app);
  }

  getItemText(item: FolderChoice): string {
    return item.label;
  }

  onChooseItem(item: FolderChoice): void {
    this.onPick(item.path);
  }
}
