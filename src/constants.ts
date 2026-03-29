export const PLUGIN_ID = 'lan-sync';
export const PLUGIN_NAME = 'LAN Sync';

export const DEFAULT_WS_PORT = 53712;
export const DISCOVERY_PORT = 53713;
export const DISCOVERY_INTERVAL_MS = 5000;
export const DEVICE_TIMEOUT_MS = 15000;

export const SYNC_VIEW_TYPE = 'lan-sync-view';

export const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'css', 'js', 'ts', 'json', 'yaml', 'yml',
  'xml', 'html', 'htm', 'csv', 'svg', 'tex', 'bib',
  'py', 'rb', 'sh', 'bash', 'zsh', 'fish',
  'c', 'cpp', 'h', 'hpp', 'java', 'kt', 'rs', 'go',
  'toml', 'ini', 'cfg', 'conf', 'properties',
  'markdown', 'mdown', 'mkdn', 'mdwn',
]);

export const CRDT_STATE_DIR = '.obsidian/plugins/lan-sync/crdt-state';
export const CONFLICT_BACKUP_DIR = '.obsidian/plugins/lan-sync/conflicts';

export const MAX_ACTIVE_DOCS = 50;
export const DEBOUNCE_MS = 200;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
export const CHUNK_SIZE = 64 * 1024; // 64 KB

export const WS_PING_INTERVAL_MS = 10000;
