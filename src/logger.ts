import { SyncLogger } from './types';

let debugEnabled = false;

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

export const logger: SyncLogger = {
  debug(...args: unknown[]) {
    if (debugEnabled) console.debug('[LAN-Vault-Sync]', ...args);
  },
  info(...args: unknown[]) {
    console.info('[LAN-Vault-Sync]', ...args);
  },
  warn(...args: unknown[]) {
    console.warn('[LAN-Vault-Sync]', ...args);
  },
  error(...args: unknown[]) {
    console.error('[LAN-Vault-Sync]', ...args);
  },
};
