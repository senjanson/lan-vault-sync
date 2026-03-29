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
