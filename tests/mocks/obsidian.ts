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
  constructor(app: any) { this.app = app; }
  open() {}
  close() {}
}
export class Notice {
  constructor(_message: string, _timeout?: number) {}
}
export function setIcon(_el: any, _icon: string) {}
