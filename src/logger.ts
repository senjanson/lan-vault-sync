import { SyncLogger } from './types';
import type { EventLog } from './diagnostics/event-log';

let debugEnabled = false;
let sink: EventLog | null = null;

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Warnings and errors are also written to the persistent sync log. */
export function setLogSink(log: EventLog | null): void {
  sink = log;
}

function text(args: unknown[]): string {
  return args
    .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeJson(a)))
    .join(' ')
    .slice(0, 2000);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const logger: SyncLogger = {
  debug(...args: unknown[]) {
    if (debugEnabled) console.debug('[LAN-Vault-Sync]', ...args);
  },
  info(...args: unknown[]) {
    console.debug('[LAN-Vault-Sync]', ...args);
  },
  warn(...args: unknown[]) {
    console.warn('[LAN-Vault-Sync]', ...args);
    sink?.record({ level: 'warn', op: 'log', msg: text(args) });
  },
  error(...args: unknown[]) {
    console.error('[LAN-Vault-Sync]', ...args);
    sink?.record({ level: 'error', op: 'error', msg: text(args) });
  },
};
