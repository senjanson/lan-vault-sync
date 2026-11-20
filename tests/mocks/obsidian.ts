export class App {}

export class Vault {
  adapter: any;
}

export class TAbstractFile {
  path: string;

  constructor(path: string) {
    this.path = path;
  }
}

export class TFile extends TAbstractFile {
  stat: { mtime: number; size: number };

  constructor(path: string) {
    super(path);
    this.stat = { mtime: Date.now(), size: 0 };
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === '/' || this.path === '';
  }
}

export class EventRef {}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class WorkspaceLeaf {}
export class ItemView {}
export class Modal {
  app: any;
  contentEl: any = {};
  titleEl: any = { setText() {} };
  modalEl: any = { addClass() {} };
  constructor(app: any) {
    this.app = app;
  }
  open() {}
  close() {}
}
export class Notice {
  /** Every message shown, for tests. */
  static shown: string[] = [];
  constructor(message: string, _timeout?: number) {
    Notice.shown.push(message);
  }
  hide() {}
}
export function setIcon(_el: any, _icon: string) {}
export class SuggestModal<T> extends Modal {
  placeholder = '';
  setPlaceholder(text: string) { this.placeholder = text; }
  getSuggestions(_query: string): T[] { return []; }
}
export class FuzzySuggestModal<T> extends SuggestModal<T> {
  getItems(): T[] { return []; }
  getItemText(_item: T): string { return ''; }
  onChooseItem(_item: T, _evt?: unknown): void {}
  /** Plain substring match, for tests (Obsidian's is fuzzy). */
  getSuggestions(query: string): T[] {
    const q = query.toLowerCase();
    return this.getItems().filter((i) => this.getItemText(i).toLowerCase().includes(q));
  }
}

/** The desktop app, as the tests run in Node. */
export const Platform = {
  isDesktop: true,
  isDesktopApp: true,
  isMobile: false,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isMacOS: process.platform === 'darwin',
  isWin: process.platform === 'win32',
  isLinux: process.platform === 'linux',
};
