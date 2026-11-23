import type { DataAdapter } from 'obsidian';
import { CRDT_STATE_DIR, FILE_INDEX_FILE, PLUGIN_ID, PLUGIN_STATE_DIR } from '../constants';
import { logger } from '../logger';
import { ensureDirectory } from './path-utils';

/**
 * Where 0.5.1 and older kept sync state, whatever the vault's config folder
 * was. Read only to bring that state over; see copyLegacyState.
 */
const LEGACY_STATE_DIR = `.obsidian/plugins/${PLUGIN_ID}`;

/** The state the plugin keeps there; not its code or settings. */
const STATE_ENTRIES = [
  'crdt-state',
  'conflicts',
  'deleted-files.json',
  'revived-files.json',
  'synced-files.json',
  'synced-files.json.bak',
  'agreed-files.json',
  'agreed-files.json.bak',
  'sync-log.json',
];

/**
 * On a vault whose config folder is not .obsidian, brings over the sync state
 * older versions kept in .obsidian/plugins/lan-vault-sync. Copied, not
 * moved: that folder may belong to another device's Obsidian. Done once,
 * while the plugin's own folder has no state yet.
 */
export async function copyLegacyState(adapter: DataAdapter): Promise<void> {
  if (PLUGIN_STATE_DIR === LEGACY_STATE_DIR) return;
  try {
    if (!(await adapter.exists(LEGACY_STATE_DIR))) return;
    if ((await adapter.exists(FILE_INDEX_FILE)) || (await adapter.exists(CRDT_STATE_DIR))) return;
    for (const name of STATE_ENTRIES) {
      await copyEntry(adapter, `${LEGACY_STATE_DIR}/${name}`, `${PLUGIN_STATE_DIR}/${name}`);
    }
    logger.info(`Copied sync state from ${LEGACY_STATE_DIR} to ${PLUGIN_STATE_DIR}`);
  } catch (err) {
    logger.warn(`Could not copy sync state from ${LEGACY_STATE_DIR}:`, err);
  }
}

async function copyEntry(adapter: DataAdapter, from: string, to: string): Promise<void> {
  const stat = await adapter.stat(from);
  if (!stat || (await adapter.exists(to))) return;
  if (stat.type === 'file') {
    await ensureDirectory(adapter, to.slice(0, to.lastIndexOf('/')));
    await adapter.copy(from, to);
    return;
  }
  await ensureDirectory(adapter, to);
  const { files, folders } = await adapter.list(from);
  for (const path of [...files, ...folders]) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    await copyEntry(adapter, `${from}/${name}`, `${to}/${name}`);
  }
}
