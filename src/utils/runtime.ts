import { Platform } from 'obsidian';

/** The global object of Obsidian's desktop app, where Electron puts Node's require(). */
export type NodeWindow = Window & { require?: (moduleName: string) => unknown };

/** Whether Node.js modules can be loaded: the desktop app, not a phone or tablet. */
export function canUseNodeRuntime(): boolean {
  return Platform.isDesktopApp && typeof (window as NodeWindow).require === 'function';
}

export function supportsIncomingConnections(): boolean {
  return canUseNodeRuntime();
}
