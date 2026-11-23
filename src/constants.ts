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

/*
 * Where sync keeps its state: the plugin's folder in the vault's config
 * folder, which the user can rename (Vault.configDir). They are set by
 * setConfigDir when the plugin loads, before anything reads them.
 */
/** The plugin's folder, e.g. .obsidian/plugins/lan-vault-sync. */
export let PLUGIN_STATE_DIR = "";
export let CRDT_STATE_DIR = "";
export let CONFLICT_BACKUP_DIR = "";
export let TOMBSTONE_FILE = "";
/** Files put back after they were deleted; see TombstoneStore.revive. */
export let REVIVED_FILE = "";
/** Files and their hashes as of the last time sync ran. */
export let FILE_INDEX_FILE = "";
/**
 * Per peer and note, the content this device last had in common with that
 * peer (see FileMeta.agreed), and times learned for notes' versions (see
 * FileMeta.madeAt).
 */
export let AGREED_HASHES_FILE = "";
export let SYNC_LOG_FILE_PATH = "";

/** Points the paths above at the vault's config folder. */
export function setConfigDir(configDir: string): void {
  PLUGIN_STATE_DIR = `${configDir}/plugins/${PLUGIN_ID}`;
  CRDT_STATE_DIR = `${PLUGIN_STATE_DIR}/crdt-state`;
  CONFLICT_BACKUP_DIR = `${PLUGIN_STATE_DIR}/conflicts`;
  TOMBSTONE_FILE = `${PLUGIN_STATE_DIR}/deleted-files.json`;
  REVIVED_FILE = `${PLUGIN_STATE_DIR}/revived-files.json`;
  FILE_INDEX_FILE = `${PLUGIN_STATE_DIR}/synced-files.json`;
  AGREED_HASHES_FILE = `${PLUGIN_STATE_DIR}/agreed-files.json`;
  SYNC_LOG_FILE_PATH = `${PLUGIN_STATE_DIR}/sync-log.json`;
}
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
/**
 * A large file's chunks are handed to the socket only while less than this
 * waits to be sent to that peer. Queueing them all at once kept the whole
 * file in memory twice (plain and encrypted) until a slow phone took it.
 */
export const SEND_BUFFER_LIMIT = 4 * 1024 * 1024; // 4 MB
/** How often a paced send looks again at what the socket still has to send. */
export const SEND_PACE_POLL_MS = 20;
/**
 * Where a large file's chunks are written as they arrive, until the whole
 * file is there and matches its hash. Starts with a dot, so it is not synced.
 */
export const INCOMING_DIR = ".lan-vault-sync/incoming";
/** Default limit for files received on a phone, in MB (desktops have none). */
export const PHONE_MAX_RECEIVE_MB = 200;

export const WS_PING_INTERVAL_MS = 10000;

/**
 * Version of the sync protocol. Devices only connect when theirs match.
 * 1: plain messages (plugin 0.3 and older, which send no version).
 * 2: encrypted messages, CRDT digests in the file list.
 * 3: deletions say what was deleted; files say which version they replace;
 *    pings carry the clock (plugin 0.5).
 */
export const PROTOCOL_VERSION = 3;

export const SYNC_LOG_VIEW_TYPE = "lan-vault-sync-log-view";
export const MAX_SYNC_LOG_ENTRIES = 500;
