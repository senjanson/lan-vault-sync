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

export const MAX_ACTIVE_DOCS = 50;
export const DEBOUNCE_MS = 200;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
export const CHUNK_SIZE = 64 * 1024; // 64 KB

export const WS_PING_INTERVAL_MS = 10000;

export const SYNC_LOG_VIEW_TYPE = "lan-vault-sync-log-view";
export const MAX_SYNC_LOG_ENTRIES = 500;
export const SYNC_LOG_FILE_PATH =
  ".obsidian/plugins/lan-vault-sync/sync-log.json";
