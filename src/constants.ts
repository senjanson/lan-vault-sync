export const PLUGIN_ID = "lan-vault-sync";
export const PLUGIN_NAME = "LAN Vault Sync";

/** Range for randomly assigned WebSocket port on first install (IANA dynamic/private range). */
export const WS_PORT_MIN = 49200;
export const WS_PORT_MAX = 65000;
export const DISCOVERY_PORT = 53713;
export const DISCOVERY_INTERVAL_MS = 5000;
export const DEVICE_TIMEOUT_MS = 15000;

export const SYNC_VIEW_TYPE = "lan-vault-sync-view";

export const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "css",
  "js",
  "ts",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "csv",
  "svg",
  "tex",
  "bib",
  "py",
  "rb",
  "sh",
  "bash",
  "zsh",
  "fish",
  "c",
  "cpp",
  "h",
  "hpp",
  "java",
  "kt",
  "rs",
  "go",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "markdown",
  "mdown",
  "mkdn",
  "mdwn",
]);

export const CRDT_STATE_DIR = ".obsidian/plugins/lan-vault-sync/crdt-state";
export const CONFLICT_BACKUP_DIR = ".obsidian/plugins/lan-vault-sync/conflicts";
export const TOMBSTONE_FILE = ".obsidian/plugins/lan-vault-sync/deleted-files.json";
/** How long a deletion is remembered for peers that were offline. */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_ACTIVE_DOCS = 50;
export const DEBOUNCE_MS = 200;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
/** Binary files larger than this are sent in FILE_CHUNK messages. A single
 *  message must stay well below the ws library's 100 MiB payload limit. */
export const CHUNKED_FILE_THRESHOLD = 8 * 1024 * 1024; // 8 MB
export const CHUNK_SIZE = 1024 * 1024; // 1 MB per FILE_CHUNK message
/** Largest binary file accepted from a peer. */
export const MAX_SYNC_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

export const WS_PING_INTERVAL_MS = 10000;

export const SYNC_LOG_VIEW_TYPE = "lan-vault-sync-log-view";
export const MAX_SYNC_LOG_ENTRIES = 500;
export const SYNC_LOG_FILE_PATH =
  ".obsidian/plugins/lan-vault-sync/sync-log.json";
