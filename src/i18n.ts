/**
 * UI text in English and Chinese. The language follows Obsidian's own
 * language setting (stored in localStorage under "language"); anything that
 * is not Chinese falls back to English.
 */

const en = {
  // Shared
  "common.copied": "Copied to clipboard",
  "common.copyFailed": "Copy failed. Select the text and copy it by hand.",
  "common.clickToCopy": "Click to copy",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.open": "Open",
  "common.clear": "Clear",
  "common.add": "Add",
  "common.copy": "Copy",

  // Commands
  "cmd.toggle": "Turn sync on or off",
  "cmd.openPanel": "Open sync panel",
  "cmd.openLog": "Open sync log",
  "cmd.addPeer": "Add device by address",
  "cmd.openRecovery": "Open recovery center",
  "cmd.exportDiagnostics": "Export diagnostics",

  // Notices from the plugin
  "notice.peerAdded": "LAN Sync: Peer {address} added",
  "notice.peerInvalid": "LAN Sync: Invalid address {address}. Use ip:port, for example 192.168.1.20:53712.",
  "notice.peerAddFailed": "LAN Sync: Failed to add peer. Invalid address: {address}",
  "notice.peerOutdated": "LAN Sync: {name} runs an older version of LAN Vault Sync. Update the plugin on that device to sync with it.",
  "notice.peerNewer": "LAN Sync: {name} runs a newer version of LAN Vault Sync. Update the plugin on this device to sync with it.",
  "notice.peerBadKey": "LAN Sync: {name} has a different sync key. Use the same key on both devices (Settings → LAN Vault Sync → Sync key).",
  "notice.peerOtherVault": "LAN Sync: {name} belongs to another vault. To sync with it, pair again from that device's QR code or pairing link.",
  "notice.cannotSync": "LAN Sync: Cannot sync {path}: {reason}.{more}",
  "notice.cannotSyncMore": " {count} more file(s) cannot be synced either; the LAN Sync panel lists them.",
  "notice.unreachable": "LAN Sync: Cannot reach {addresses}. Retrying in the background.",
  "notice.localNetworkHint": " If that device is on and on the same network, check that Obsidian is allowed to use the local network (iPhone: Settings → Privacy & Security → Local Network).",
  "notice.error": "LAN Sync: {error}",

  "pair.addTitle": "Add a device by address",
  "pair.title": "Pair with device",
  "pair.confirm": "Pair",
  "pair.ask": "Add the device at {address} as a sync peer?",
  "pair.keyChange": "This also sets this device's sync key to the one in the link. Other devices that use the current key will stop syncing with this one until they get the new key.",
  "pair.onlyYours": "Only continue if you opened this link yourself, for example by scanning the QR code on your own device.",

  // Settings
  "set.enable": "Enable sync",
  "set.enableDesc": "Turn LAN Vault Sync on or off.",
  "set.deviceName": "Device name",
  "set.deviceNameDesc": "A friendly name for this device.",
  "set.deviceNamePlaceholder": "e.g. MacBook Pro",
  "set.port": "Port",
  "set.portDesc": "WebSocket port for sync. Other devices that use a manual address must be given the new port.",
  "set.portDescOutbound": "This device cannot accept incoming connections. Keep this port aligned with your desktop peers if needed.",
  "set.portPlaceholder": "auto-assigned",
  "set.syncKey": "Sync key",
  "set.syncKeyIntro": "Only devices with the same sync key can connect to each other. Scanning this device's QR code copies the key; otherwise enter the same key on every device. Synced data is encrypted with this key.",
  "set.syncKeyDesc": "Changing it reconnects with the new key when you leave the field.",
  "set.syncKeyTooShort": "LAN Sync: the sync key needs at least 8 letters or digits",
  "set.syncKeyCopied": "LAN Sync: sync key copied",
  "set.newKey": "New key",
  "set.newKeySet": "LAN Sync: new sync key set. Pair your other devices again.",
  "set.deviceId": "Device ID",
  "set.deviceIdDesc": "This device's ID is {id}. Every device needs its own; give this one a new ID if another device shows the same.",
  "set.regenerateId": "New device ID",
  "set.regenerateIdConfirm": "This device gets a new ID, and its record of synced files is cleared, so the next sync compares every file again. Nothing in the vault is deleted.",
  "notice.duplicateDevice": "LAN Sync: another device ({name}) uses this device's ID, so the two cannot sync with each other. Give one of them a new device ID.",
  "notice.idRegenerated": "LAN Sync: this device's new ID is {id}.",
  "set.qrHeading": "Pair with QR code",
  "set.qrOutbound": "This device is running in outbound-only mode. On iPhone/iPad, please scan the QR code shown on a desktop device or add the desktop peer manually.",
  "set.qrIntro": "Let another device scan this QR code to quickly add this device as a peer.",
  "set.qrNoIp": "Unable to detect local IP address. QR code pairing requires a network connection.",
  "set.qrAddress": "Address: {address}",
  "set.networkInterface": "Network interface",
  "set.networkInterfaceDesc": "Select which IP address to use.",
  "set.peersHeading": "Devices by address",
  "set.peersIntro": "Add peers manually if auto-discovery doesn't work. Format: ip:port",
  "set.addDevice": "Add device",
  "set.scopeHeading": "What to sync",
  "set.syncFolder": "Sync only this folder",
  "set.syncFolderDesc": "Only this folder is synced with other devices, and they keep to it on their own. The folder must have exactly the same name on every device (case matters). Moving a file out of the folder deletes it on the other devices (it can be restored from the recovery center). Choose the folder before pairing. With a folder set, this device does not sync with older versions of the plugin.",
  "set.syncFolderWhole": "Whole vault",
  "set.syncFolderNoLimit": "Whole vault (no limit)",
  "set.syncFolderChoose": "Choose folder",
  "set.syncFolderFind": "Type to find a folder",
  "set.syncFolderMissing": "(folder not found)",
  "set.ignoredHeading": "Ignored paths",
  "set.ignoredDesc": "Paths to exclude from sync (one per line). Paths ending with / match directories.",
  "set.manualHeading": "Manual sync",
  "set.manualHint": "Click \"Sync now\" to start a full sync.",
  "set.fullSync": "Full sync",
  "set.fullSyncDesc": "Manually trigger a full sync with all connected peers.",
  "set.syncNow": "Sync now",
  "set.syncing": "Syncing...",
  "set.starting": "Starting...",
  "set.syncDone": "LAN Sync: Full sync complete!",
  "set.syncFailedLabel": "Sync failed. Check console for details.",
  "set.syncFailed": "LAN Sync: Sync failed!",
  "set.advanced": "Advanced",
  "set.interval": "Sync check interval",
  "set.intervalDesc": "Interval for periodic full sync check (in seconds). 0 to disable.",
  "set.debug": "Debug logging",
  "set.debugDesc": "Enable verbose logging in the developer console.",
  "set.logHeading": "Sync log",
  "set.logEnable": "Enable sync log",
  "set.logEnableDesc": "Record all sync operations for review and restoration.",
  "set.logMax": "Max log entries",
  "set.logMaxDesc": "Maximum number of sync log entries to keep.",
  "set.logOpen": "Open sync log",
  "set.logOpenDesc": "View all sync operations in a side panel.",
  "set.logClear": "Clear sync log",
  "set.logClearDesc": "Delete all sync log entries.",
  "set.logCleared": "Sync log cleared",

  // Status bar
  "status.off": "LAN Sync: Off",
  "status.searching": "LAN Sync: Searching...",
  "status.connecting": "LAN Sync: Connecting...",
  "status.syncing": "LAN Sync: Syncing...",
  "status.peers": "LAN Sync: {count} peer(s)",
  "status.error": "LAN Sync: Error",
  "status.unreachable": "can't reach {what}",

  // Sync panel
  "view.title": "LAN Sync",
  "view.status": "Status",
  "view.cannotReach": "Cannot reach {address}. Retrying in the background.",
  "view.localNetworkHint": "If that device is on and on the same network, check that Obsidian is allowed to use the local network (iPhone: Settings → Privacy & Security → Local Network).",
  "view.devices": "Connected devices ({count})",
  "view.noDevices": "No devices connected",
  "view.events": "Sync events",
  "view.noEvents": "No events yet",
  "set.historyHeading": "Version history",
  "set.historyKeepDays": "Keep old versions for (days)",
  "set.historyKeepDaysDesc": "Versions kept before sync deleted or replaced a file, in .lan-vault-sync/history in the vault.",
  "set.historyMaxMB": "Space limit on a phone (MB)",
  "set.historyMaxMBDesc": "When the history is larger, the oldest versions go first. 0 for no limit. Computers have no limit.",
  "set.recoveryOpen": "Recovery center",
  "set.recoveryOpenDesc": "Find and restore old versions of files, one by one or a whole batch at once.",
  "view.held": "Deletions waiting for you ({count})",
  "view.heldInferred": "{count} file(s) are missing here since sync last ran. Delete them on the other devices too?",
  "view.heldIncoming": "{peer} deleted {count} file(s) here at once. Delete them on this device?",
  "view.heldMore": "and {count} more",
  "view.heldDelete": "Delete them",
  "view.heldKeep": "Keep them",
  "view.heldGone": "These deletions were already handled; nothing was changed.",
  "notice.held": "LAN Sync: {count} deletion(s) are on hold until you confirm them. Open the LAN Sync panel to delete or keep the files.",
  "state.idle": "⏸ Idle",
  "state.discovering": "🔍 Discovering...",
  "state.connecting": "🔗 Connecting...",
  "state.initial-sync": "🔄 Initial sync...",
  "state.watching": "✅ Syncing",
  "state.error": "⚠️ Error",

  // Sync log view and modal
  "log.title": "Sync log",
  "log.empty": "No sync log entries yet",
  "log.allTypes": "All types",
  "log.type.remote-overwrite": "Remote overwrite",
  "log.type.remote-delete": "Remote delete",
  "log.type.local-send": "Local send",
  "log.type.initial-sync-receive": "Initial sync",
  "log.type.conflict-backup": "Conflict backup",
  "log.search": "Search file paths...",
  "log.preview": "Preview",
  "log.restore": "Restore",
  "log.copyContent": "Copy content",
  "log.openFile": "Open file",
  "log.copyPath": "Copy path",
  "log.pathCopied": "Path copied to clipboard",
  "log.fileMissing": "File does not exist: {path}",
  "log.restored": "Restored: {path}",
  "log.restoreFailed": "Restore failed: {path}",
  "log.unreadable": "Cannot read the snapshot",
  "log.modalTitle": "Sync log — {path}",
  "log.snapshot": "Snapshot",
  "log.diff": "Diff",
  "log.diffLegend": "Red = in the snapshot but not now, green = new now",
  "log.diffTooBig": "(File too large: {lines} lines, detailed diff omitted)",
  "log.diffCurrentLines": "(Current file has {lines} lines)",
};

export type I18nKey = keyof typeof en;

const zh: Record<I18nKey, string> = {
  "common.copied": "已复制到剪贴板",
  "common.copyFailed": "复制失败，请手动选中文本",
  "common.clickToCopy": "点击复制",
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.open": "打开",
  "common.clear": "清空",
  "common.add": "添加",
  "common.copy": "复制",

  "cmd.toggle": "开启或关闭同步",
  "cmd.openPanel": "打开同步面板",
  "cmd.openLog": "打开同步日志",
  "cmd.addPeer": "按地址添加设备",
  "cmd.openRecovery": "打开恢复中心",
  "cmd.exportDiagnostics": "导出诊断包",

  "notice.peerAdded": "LAN Sync：已添加设备 {address}",
  "notice.peerInvalid": "LAN Sync：地址 {address} 无效。请用 ip:端口 的格式，例如 192.168.1.20:53712。",
  "notice.peerAddFailed": "LAN Sync：添加设备失败，地址无效：{address}",
  "notice.peerOutdated": "LAN Sync：{name} 上的 LAN Vault Sync 版本较旧。请在那台设备上更新插件后再同步。",
  "notice.peerNewer": "LAN Sync：{name} 上的 LAN Vault Sync 版本较新。请在这台设备上更新插件后再同步。",
  "notice.peerBadKey": "LAN Sync：{name} 的同步密钥不同。请在两台设备上使用相同的密钥（设置 → LAN Vault Sync → 同步密钥）。",
  "notice.peerOtherVault": "LAN Sync：{name} 属于另一个库。要和它同步，请用那台设备的二维码或配对链接重新配对。",
  "notice.cannotSync": "LAN Sync：无法同步 {path}：{reason}。{more}",
  "notice.cannotSyncMore": "另有 {count} 个文件也无法同步，同步面板里列出了它们。",
  "notice.unreachable": "LAN Sync：连不上 {addresses}，正在后台重试。",
  "notice.localNetworkHint": "如果那台设备开着且在同一网络，请检查 Obsidian 是否有本地网络权限（iPhone：设置 → 隐私与安全性 → 本地网络）。",
  "notice.error": "LAN Sync：{error}",

  "pair.addTitle": "按地址添加设备",
  "pair.title": "与设备配对",
  "pair.confirm": "配对",
  "pair.ask": "把 {address} 上的设备添加为同步对象？",
  "pair.keyChange": "这也会把这台设备的同步密钥改成链接里的密钥。仍在使用当前密钥的其他设备会停止和这台同步，直到它们也换成新密钥。",
  "pair.onlyYours": "只有在你自己打开这个链接时才继续，例如扫描你自己设备上的二维码。",

  "set.enable": "启用同步",
  "set.enableDesc": "开启或关闭 LAN Vault Sync。",
  "set.deviceName": "设备名称",
  "set.deviceNameDesc": "这台设备的显示名称。",
  "set.deviceNamePlaceholder": "例如 MacBook Pro",
  "set.port": "端口",
  "set.portDesc": "同步使用的 WebSocket 端口。用手动地址连接的其他设备需要改成新端口。",
  "set.portDescOutbound": "这台设备不能接受传入连接。需要时让这个端口和桌面设备保持一致。",
  "set.portPlaceholder": "自动分配",
  "set.syncKey": "同步密钥",
  "set.syncKeyIntro": "只有同步密钥相同的设备才能互相连接。扫描这台设备的二维码会复制密钥；否则请在每台设备上输入相同的密钥。同步的数据用这个密钥加密。",
  "set.syncKeyDesc": "修改后离开输入框时会用新密钥重新连接。",
  "set.syncKeyTooShort": "LAN Sync：同步密钥至少需要 8 个字母或数字",
  "set.syncKeyCopied": "LAN Sync：已复制同步密钥",
  "set.newKey": "新密钥",
  "set.newKeySet": "LAN Sync：已设置新的同步密钥。请重新配对其他设备。",
  "set.deviceId": "设备 ID",
  "set.deviceIdDesc": "本设备的 ID 是 {id}。每台设备的 ID 都必须不同；如果另一台设备显示同样的 ID，就给这台换一个。",
  "set.regenerateId": "换新设备 ID",
  "set.regenerateIdConfirm": "本设备会换一个新 ID，并清空已同步文件的记录，下次同步会重新比对所有文件。仓库里的文件不会被删除。",
  "notice.duplicateDevice": "LAN Sync：另一台设备（{name}）和本设备用的是同一个 ID，两台之间无法同步。请给其中一台换新设备 ID。",
  "notice.idRegenerated": "LAN Sync：本设备的新 ID 是 {id}。",
  "set.qrHeading": "用二维码配对",
  "set.qrOutbound": "这台设备只能主动连接。在 iPhone/iPad 上，请扫描桌面设备上显示的二维码，或手动添加桌面设备。",
  "set.qrIntro": "让另一台设备扫描这个二维码，即可把这台设备添加为同步对象。",
  "set.qrNoIp": "无法获取本机 IP 地址。二维码配对需要网络连接。",
  "set.qrAddress": "地址：{address}",
  "set.networkInterface": "网络接口",
  "set.networkInterfaceDesc": "选择要使用的 IP 地址。",
  "set.peersHeading": "按地址添加的设备",
  "set.peersIntro": "自动发现不起作用时可以手动添加设备。格式：ip:端口",
  "set.addDevice": "添加设备",
  "set.scopeHeading": "同步范围",
  "set.syncFolder": "仅同步此文件夹",
  "set.syncFolderDesc": "只和其他设备同步这个文件夹，其他设备会自动遵守。每台设备上的文件夹名必须完全相同（区分大小写）。把文件移出这个文件夹，等于在其他设备上删除它（可以在恢复中心找回）。建议先选好文件夹再配对。设了文件夹后，这台设备不能和旧版本的插件同步。",
  "set.syncFolderWhole": "整个库",
  "set.syncFolderNoLimit": "整个库（不限制）",
  "set.syncFolderChoose": "选择文件夹",
  "set.syncFolderFind": "输入以查找文件夹",
  "set.syncFolderMissing": "（文件夹不存在）",
  "set.ignoredHeading": "忽略的路径",
  "set.ignoredDesc": "不参与同步的路径（每行一个）。以 / 结尾的路径匹配文件夹。",
  "set.manualHeading": "手动同步",
  "set.manualHint": "点击“立即同步”开始一次完整同步。",
  "set.fullSync": "完整同步",
  "set.fullSyncDesc": "手动和所有已连接的设备做一次完整同步。",
  "set.syncNow": "立即同步",
  "set.syncing": "同步中...",
  "set.starting": "正在开始...",
  "set.syncDone": "LAN Sync：完整同步已完成！",
  "set.syncFailedLabel": "同步失败，详情见控制台。",
  "set.syncFailed": "LAN Sync：同步失败！",
  "set.advanced": "高级",
  "set.interval": "同步检查间隔",
  "set.intervalDesc": "定期完整同步检查的间隔（秒）。0 表示关闭。",
  "set.debug": "调试日志",
  "set.debugDesc": "在开发者控制台输出详细日志。",
  "set.logHeading": "同步日志",
  "set.logEnable": "启用同步日志",
  "set.logEnableDesc": "记录所有同步操作，便于查看和还原。",
  "set.logMax": "日志条数上限",
  "set.logMaxDesc": "最多保留的同步日志条数。",
  "set.logOpen": "打开同步日志",
  "set.logOpenDesc": "在侧边栏查看所有同步操作。",
  "set.logClear": "清空同步日志",
  "set.logClearDesc": "删除所有同步日志条目。",
  "set.logCleared": "已清空同步日志",

  "status.off": "LAN Sync：已关闭",
  "status.searching": "LAN Sync：正在搜索...",
  "status.connecting": "LAN Sync：正在连接...",
  "status.syncing": "LAN Sync：同步中...",
  "status.peers": "LAN Sync：{count} 台设备",
  "status.error": "LAN Sync：出错",
  "status.unreachable": "连不上 {what}",

  "view.title": "LAN Sync",
  "view.status": "状态",
  "view.cannotReach": "连不上 {address}，正在后台重试。",
  "view.localNetworkHint": "如果那台设备开着且在同一网络，请检查 Obsidian 是否有本地网络权限（iPhone：设置 → 隐私与安全性 → 本地网络）。",
  "view.devices": "已连接的设备（{count}）",
  "view.noDevices": "没有已连接的设备",
  "view.events": "同步事件",
  "view.noEvents": "暂无事件",
  "set.historyHeading": "版本历史",
  "set.historyKeepDays": "旧版本保留天数",
  "set.historyKeepDaysDesc": "同步删除或替换文件前保存的旧版本，放在仓库的 .lan-vault-sync/history 里。",
  "set.historyMaxMB": "手机上的空间上限（MB）",
  "set.historyMaxMBDesc": "超过时从最旧的版本删起。填 0 表示不限。电脑上不设上限。",
  "set.recoveryOpen": "恢复中心",
  "set.recoveryOpenDesc": "查找并恢复文件的旧版本，可以逐个恢复，也可以整批恢复。",
  "view.held": "等你确认的删除（{count}）",
  "view.heldInferred": "自上次同步以来，这里少了 {count} 个文件。要在其他设备上也删除吗？",
  "view.heldIncoming": "{peer} 一次删除了 {count} 个文件。要在这台设备上也删除吗？",
  "view.heldMore": "另有 {count} 个",
  "view.heldDelete": "删除",
  "view.heldKeep": "保留",
  "view.heldGone": "这批删除已经处理过了，没有做任何改动。",
  "notice.held": "LAN Sync：有 {count} 个删除被暂停，等你确认。打开同步面板选择删除或保留这些文件。",
  "state.idle": "⏸ 空闲",
  "state.discovering": "🔍 正在发现...",
  "state.connecting": "🔗 正在连接...",
  "state.initial-sync": "🔄 初始同步...",
  "state.watching": "✅ 同步中",
  "state.error": "⚠️ 出错",

  "log.title": "同步日志",
  "log.empty": "暂无同步日志",
  "log.allTypes": "全部类型",
  "log.type.remote-overwrite": "远程覆写",
  "log.type.remote-delete": "远程删除",
  "log.type.local-send": "本地发送",
  "log.type.initial-sync-receive": "初始同步",
  "log.type.conflict-backup": "冲突备份",
  "log.search": "搜索文件路径...",
  "log.preview": "预览",
  "log.restore": "还原",
  "log.copyContent": "复制内容",
  "log.openFile": "打开文件",
  "log.copyPath": "复制路径",
  "log.pathCopied": "已复制路径到剪贴板",
  "log.fileMissing": "文件不存在：{path}",
  "log.restored": "已还原：{path}",
  "log.restoreFailed": "还原失败：{path}",
  "log.unreadable": "无法读取快照内容",
  "log.modalTitle": "同步日志 — {path}",
  "log.snapshot": "快照内容",
  "log.diff": "差异对比",
  "log.diffLegend": "红色 = 快照中有但当前没有，绿色 = 当前新增",
  "log.diffTooBig": "（文件过大，共 {lines} 行，已省略详细对比）",
  "log.diffCurrentLines": "（当前文件共 {lines} 行）",
};

export type Lang = "en" | "zh";
const tables: Record<Lang, Record<string, string>> = { en, zh };
let forced: Lang | null = null;

function detect(): Lang {
  try {
    const stored = window.localStorage?.getItem("language") ?? "";
    return stored.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "en";
  }
}

/** For tests: pin the language, or pass null to follow Obsidian again. */
export function setLanguage(lang: Lang | null): void {
  forced = lang;
}

export function currentLanguage(): Lang {
  return forced ?? detect();
}

/** Registers more strings (used by later modules for their own text). */
export function addStrings(lang: Lang, strings: Record<string, string>): void {
  Object.assign(tables[lang], strings);
}

export function t(key: I18nKey | string, vars?: Record<string, string | number>): string {
  return tIn(currentLanguage(), key, vars);
}

/** A string in the given language, whatever the user's: e.g. English for the log. */
export function tIn(lang: Lang, key: I18nKey | string, vars?: Record<string, string | number>): string {
  const text = tables[lang][key] ?? tables.en[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}

/** The locale that dates and times are written in: the UI language's, not the system region's. */
function locale(): string {
  return currentLanguage() === "zh" ? "zh-CN" : "en-US";
}

/** A time of day in the UI language (16:28:29, or 4:28:29 PM). */
export function formatTime(ts: number, opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", second: "2-digit" }): string {
  return new Date(ts).toLocaleTimeString(locale(), opts);
}

/** A date in the UI language (2026/11/18, or 11/18/2026). */
export function formatDate(ts: number): string {
  const pad = currentLanguage() === "zh" ? "2-digit" : "numeric";
  return new Date(ts).toLocaleDateString(locale(), { year: "numeric", month: pad, day: pad });
}

/** A date and time in the UI language. */
export function formatDateTime(ts: number): string {
  return `${formatDate(ts)} ${formatTime(ts)}`;
}

/**
 * When something happened, as short as it can be said: the time of day
 * (hours and minutes) for today; the date before it for another day
 * (11-18 14:02, or Nov 18, 2:02 PM); the year too for another year
 * (2025-11-18 14:02, or Nov 18, 2025, 2:02 PM). "Today" is the day of `now`
 * on this device's clock.
 */
export function formatWhen(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const zh = currentLanguage() === "zh";
  // 09:05 in Chinese, 9:05 AM in English.
  const time = formatTime(ts, { hour: zh ? "2-digit" : "numeric", minute: "2-digit" });
  const sameYear = d.getFullYear() === today.getFullYear();
  if (sameYear && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) return time;
  if (zh) {
    const p = (n: number) => String(n).padStart(2, "0");
    const day = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return `${sameYear ? day : `${d.getFullYear()}-${day}`} ${time}`;
  }
  const day = d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
  return `${day}, ${time}`;
}
