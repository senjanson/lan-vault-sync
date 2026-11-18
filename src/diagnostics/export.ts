/**
 * Diagnostics export (plan 5.2): one JSON file with what is needed to
 * understand a sync problem, and nothing that would let someone join the
 * devices. The sync key is masked wherever it appears, settings or log.
 */

import type { LANSyncSettings } from "../types";
import type { LogRecord } from "./event-log";
import { DATA_DIR } from "./event-log";
import type { Alert, PeerHealth } from "./health";
import { LOG_RULES } from "./rules";

export const DIAGNOSTICS_DIR = `${DATA_DIR}/diagnostics`;
const MASK = "****";

export interface DiagnosticsInput {
  pluginVersion: string;
  platform: string;
  settings: LANSyncSettings;
  state: string;
  peers: Array<{ deviceId: string; deviceName?: string; ip?: string; port?: number }>;
  health: PeerHealth[];
  alerts: Alert[];
  held: Array<{ id: string; kind: string; count: number; peer?: string }>;
  history?: { bytes: number; versions: number } | null;
  tombstones?: number;
  /** Log records, oldest first. */
  log: LogRecord[];
  now?: number;
}

/** Settings with every secret replaced. */
export function maskSettings(settings: LANSyncSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    out[k] = /key|secret|token|password/i.test(k) && v ? MASK : v;
  }
  return out;
}

/** The export as text, with the sync key masked anywhere in it. */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const now = input.now ?? Date.now();
  const data = {
    generatedAt: new Date(now).toISOString(),
    pluginVersion: input.pluginVersion,
    platform: input.platform,
    state: input.state,
    settings: maskSettings(input.settings),
    peers: input.peers,
    health: input.health,
    alerts: input.alerts,
    held: input.held,
    history: input.history ?? null,
    tombstones: input.tombstones ?? null,
    rules: LOG_RULES,
    log: input.log,
  };
  let text = JSON.stringify(data, null, 1);
  const key = input.settings.syncKey;
  if (key) {
    text = text.split(key).join(MASK);
    // The key without its dashes, as some links carry it.
    const bare = key.replace(/-/g, "");
    if (bare.length >= 8) text = text.split(bare).join(MASK);
  }
  // Pairing links put the key in a "key=" parameter.
  return text.replace(/([?&]key=)[^&"\s]+/gi, `$1${MASK}`);
}

export function diagnosticsFileName(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DIAGNOSTICS_DIR}/diagnostics-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
}
