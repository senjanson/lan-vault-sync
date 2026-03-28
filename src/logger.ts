import { SyncLogger } from './types';

let debugEnabled = false;

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

export const logger: SyncLogger = {
  debug(...args: unknown[]) {
    if (debugEnabled) console.debug('[LAN-Sync]', ...args);
  },
  info(...args: unknown[]) {
    console.info('[LAN-Sync]', ...args);
  },
  warn(...args: unknown[]) {
    console.warn('[LAN-Sync]', ...args);
  },
  error(...args: unknown[]) {
    console.error('[LAN-Sync]', ...args);
  },
};
