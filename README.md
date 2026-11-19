# LAN Vault Sync — Obsidian Plugin

> Real-time, conflict-free vault synchronization across your local network — no cloud, no server, no subscription.

Edit on your Mac and see changes appear instantly on your iPhone. All traffic stays on your LAN.

![Obsidian](https://img.shields.io/badge/Obsidian-v1.4.0%2B-7C3AED?logo=obsidian&logoColor=white)
![Platform](https://img.shields.io/badge/platform-desktop%20%7C%20mobile-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Why LAN Vault Sync?

Most sync solutions route your notes through a third-party server. LAN Vault Sync is different:

- **Zero cloud** — data never leaves your local network
- **Zero configuration** — devices discover each other automatically via UDP broadcast
- **Zero conflicts** (for text) — Yjs CRDT merges concurrent edits at the character level, the same technology that powers Google Docs-style collaboration
- **Zero subscription** — fully open source and free forever

---

## Features

| Feature | Details |
|---|---|
| **Real-time sync** | File changes pushed to all peers within seconds via WebSocket |
| **CRDT text merge** | Markdown / text files merged automatically at character level using [Yjs](https://github.com/yjs/yjs) — no conflicts, no data loss |
| **Binary file sync** | Images, PDFs, and other attachments synced via SHA-256 hash comparison. Changed on one side, that side wins; changed on both, the later version wins and the other is kept (see [Conflict Resolution](#conflict-resolution)) |
| **Auto-discovery** | Devices find each other via UDP broadcast — zero configuration needed |
| **Manual peers** | Add peers by `IP:port` for networks where broadcast is blocked |
| **QR code pairing** | Generate a QR code on desktop; scan with your phone to add the peer instantly — no typing required |
| **Offline-friendly** | Edit while offline; changes are merged automatically on reconnect |
| **P2P architecture** | Every device is equal — no central server or hub required |
| **Version history** | Every version replaced or deleted by sync is kept for 30 days in `.lan-vault-sync/history`; restore it from the recovery center |
| **Sync one folder** | A device can sync only one folder of the vault (a work computer only `Work`, say); the other devices keep to it on their own |
| **Delete protection** | Many deletions at once, or deletions found after sync was off, wait for your confirmation |
| **Sync health** | The status bar and sync panel show, per device, whether everything is in sync, and raise an alert when something needs you |
| **Diagnostics export** | One command writes a diagnostics file to share when something goes wrong, with the sync key masked |

---

## How It Works

```
Device A (Mac)                        Device B (iPhone / iPad)
┌──────────────────┐  WebSocket P2P  ┌──────────────────┐
│  Obsidian        │◄───────────────►│  Obsidian        │
│  + LAN Vault Sync│   Yjs CRDT      │  + LAN Vault Sync│
└──────────────────┘   updates       └──────────────────┘
         ▲                                    ▲
         │         UDP broadcast              │
         └────────────────────────────────────┘
               (auto-discovery, LAN only)
```

1. On startup, each device announces itself via UDP broadcast and listens for announcements from peers.
2. Devices establish WebSocket connections to each other (every node is both server and client).
3. File tree metadata is exchanged; missing or changed files are requested.
4. **Text files** (`.md`, `.txt`, etc.) sync via Yjs CRDT — edits from multiple devices are merged automatically, even if made simultaneously while offline.
5. **Binary files** (images, PDFs, etc.) sync via SHA-256 hash comparison; the most-recently-modified version wins.

---

## Installation

### From Obsidian Community Plugins *(coming soon)*

1. Open **Settings → Community Plugins → Browse**
2. Search for **LAN Vault Sync**
3. Click **Install**, then **Enable**

### Manual Installation

1. Go to the [Releases](https://github.com/your-username/obsidian-lan-vault-sync/releases) page and download the latest `main.js`, `manifest.json`, and `styles.css`.
2. In your vault, create the folder `.obsidian/plugins/lan-vault-sync/`.
3. Copy the three downloaded files into that folder.
4. In Obsidian, go to **Settings → Community Plugins**, toggle off **Restricted Mode**, and enable **LAN Vault Sync**.

### Upgrading to 0.5

- **Update every device at the same time.** Version 0.5 speaks sync protocol 3 and does not sync with 0.4 or older. A device with an older version is refused with a notice that names it.
- **New `.lan-vault-sync/` folder in the vault.** It holds the version history (`history/`), the activity log, diagnostics exports and files being received. Obsidian does not show it and it is not synced. Exclude it from other sync or backup tools if you like; deleting it only loses the version history.
- **Pair again to share the vault ID.** Each vault now has its own ID, sent in the pairing link and QR code, so two vaults with the same folder name are told apart. Devices paired before keep working: until you pair again, the vault's folder name stands in for the ID, as before.
- **Recovery center.** Run *Open recovery center* to see every version that sync replaced or deleted, and put any back. An attachment changed on one side only no longer leaves a conflict copy: the changed side wins. Changed on both sides, the later version wins; the losing side keeps a conflict copy beside the file only if its version exists on no other device, and the replaced version also goes to the history.
- **Large files.** Files are streamed and checked on arrival. Phones take files up to 200 MB by default (setting *Largest file to receive*); a larger file is not sent to them and the sync panel says which.
- **Same device ID on two devices** (for example after copying a vault with its `.obsidian` folder) is now detected. Use *New device ID* in settings on one of them.
- The *Conflict strategy* setting is gone: every conflict keeps both versions.

### Upgrading to 0.4

- **Update every device at the same time.** Version 0.4 encrypts sync traffic, so it does not sync with 0.3 or older. A device with an older version is refused with a notice that names it.
- **Set command hotkeys again.** The commands were renamed to follow Obsidian's guidelines, so hotkeys set for the old ones no longer apply.
- The first connection after the update sends every note once more; later connections only send notes that differ.

---

## Usage

### Quick Start

1. Install the plugin on **two or more devices** connected to the same Wi-Fi or LAN.
2. Open Obsidian on each device.
3. The plugin automatically discovers peers and begins syncing within seconds.

### QR Code Pairing (Recommended for Mobile)

The easiest way to connect a phone or tablet — no typing required:

1. On the **desktop (Mac / Windows / Linux)**: open **Settings → LAN Vault Sync** and find the **Pair with QR code** section. A QR code is displayed automatically.
2. On your **phone / tablet**: scan the QR code with the system camera (or any QR scanner).
3. The camera will prompt you to open Obsidian, and the plugin asks whether to pair with that device. Confirm, and it adds the desktop's IP:port as a peer and takes over the **sync key** from the QR code.

> **Tip:** If your desktop has multiple network interfaces (e.g. Wi-Fi + Ethernet), use the dropdown above the QR code to select the correct IP before scanning.

### Sync Key

Only devices with the **same sync key** can connect to each other. Each device creates a random key on first start (**Settings → LAN Vault Sync → Sync Key**). QR pairing copies the key; when adding a peer by hand, enter the same key on both devices. A notice appears when keys don't match. All devices need a plugin version with sync keys.

### Manual Peer Connection

Auto-discovery uses UDP broadcast, which is blocked on some managed Wi-Fi networks (guest networks, corporate networks). In that case:

1. On **Device A**: open plugin settings and note the displayed **IP address** and **port** (default: `53712`).
2. On **Device B**: go to **Settings → LAN Vault Sync → Devices by address** → enter `192.168.x.x:53712`.
3. Alternatively, use the command palette: **LAN Vault Sync: Add device by address**.

### Sync Only One Folder

A device can be limited to one folder of the vault. Say the whole vault syncs between your home computer and your phone, and your work computer should get only the `Work` folder, without even the names of your other notes. On the work computer, open **Settings → LAN Vault Sync → What to sync → Sync only this folder**, click **Choose folder** and pick `Work`. Nothing has to be set on the other devices: each device says its folder when it connects, and the other side keeps to it. The work computer syncs only `Work` with your phone, and the phone, which has the whole vault, passes changes on to your home computer.

- **Same name everywhere.** The folder is matched by its path, so it must have exactly the same name on every device, case included (`Work` and `work` are two different folders). The settings and the sync panel warn when the folder is missing on a device.
- **Moving out is deleting.** Moving a file out of the folder deletes it on the devices that sync only that folder, and moving one in adds it. Deleted versions go to the version history and can be restored from the recovery center.
- **Choose the folder before pairing.** Set it before the device first syncs, so that the rest of the vault never reaches it.
- **Not with older versions.** A device with a folder set does not sync with devices that run a plugin version without this setting; update the plugin on every device.
- **The folder name is sent in the clear** when two devices connect, before the encrypted connection is set up.

The sync panel marks a connection limited to one folder with *syncs only Work*. Only one folder can be chosen, and ignored paths still apply inside it.

### Status Bar

The status bar says whether this device is in sync with the others, for example *LAN Sync: in sync with 3 · 14:02*, or how many files are still different, or that something needs you. Click it to open the sync panel, which shows each device, any alerts, and buttons to dismiss them or export diagnostics. A device that is away stays listed, also after a restart, with when its files last all matched; it is dropped after 30 days without being seen.

### Commands

Open the command palette (`Cmd/Ctrl + P`) and search for:

- **LAN Vault Sync: Turn sync on or off** — start or stop the sync service
- **LAN Vault Sync: Open sync panel** — open the sidebar panel with connected peers and sync log
- **LAN Vault Sync: Add device by address** — add a peer by `IP:port`
- **LAN Vault Sync: Open sync log** — open the sync log
- **LAN Vault Sync: Open recovery center** — see and restore versions that sync replaced or deleted
- **LAN Vault Sync: Export diagnostics** — write a diagnostics file (sync key masked) to `.lan-vault-sync/diagnostics/` and copy it

Version 0.4 renamed these commands, so hotkeys set for them before must be set again.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Enable Sync | On | Master on/off switch |
| Device Name | Auto-generated | Friendly name shown to other peers |
| Port | `53712` | WebSocket listening port |
| Sync only this folder | Whole vault | The one folder this device syncs; other devices keep to it (see [Sync Only One Folder](#sync-only-one-folder)) |
| Ignored Paths | `.obsidian/`, `.trash/` | Glob patterns excluded from sync |
| Sync Check Interval | `30s` | Period between full file-tree verification passes |
| Debug Logging | Off | Write verbose logs to the developer console |
| Keep old versions for (days) | `30` | How long the version history keeps replaced and deleted versions |
| Space limit on a phone (MB) | `500` | Space the history may take on a phone; oldest versions go first |
| Largest file to receive (MB) | `200` on phones, `0` (no limit) on computers | Larger files from other devices are not taken |
| Device ID | Generated | Shown with a *New device ID* button, for when two devices share one |

---

## Technical Details

### Architecture

- **Topology**: Peer-to-peer mesh — each node runs a WebSocket server and connects to every known peer as a client
- **Text sync**: [Yjs](https://github.com/yjs/yjs) CRDT with [`fast-diff`](https://github.com/jhchen/fast-diff) for efficient delta computation
- **Binary sync**: SHA-256 hash comparison; full file transferred when hashes differ
- **Discovery**: UDP broadcast on port `53713` (same subnet only)
- **CRDT persistence**: Yjs document states saved to `.obsidian/plugins/lan-vault-sync/crdt-state/`
- **Version history**: Replaced and deleted versions kept in `.lan-vault-sync/history/` for 30 days
- **State files**: Written to a temporary file and renamed, with a `.bak` of the previous one, so a crash mid-save cannot lose the record of synced or deleted files

### Conflict Resolution

| File type | Strategy |
|---|---|
| Text (`.md`, `.txt`, `.canvas`, …) | Yjs CRDT — automatic, **lossless** merge at character level |
| Binary (images, PDFs, audio, …) | Changed on one side: that side wins, no copy. Changed on both: the later version wins; the losing side keeps a conflict copy (`name (conflict 1a2b3c).ext`) if its version exists only on that device. The replaced version also goes to the version history |

### Mobile Compatibility

- Mobile devices (iOS / Android) act as WebSocket **clients** only — they cannot run a server due to OS restrictions.
- A desktop device must be reachable on the network to act as a server for mobile clients.
- Auto-discovery may not work on mobile; use **Pair with QR code** or **Devices by address** as a fallback.
- Sync resumes automatically when the Obsidian app returns to the foreground.

### Privacy & Security

- All traffic is **LAN-only**. No data is sent to any external server.
- Only devices that know the sync key can connect; the key itself is never sent over the network.
- A device set to sync only one folder sends that folder's name unencrypted when it connects.
- Since version 0.4, synced data is encrypted (AES-256-GCM) with keys derived from the sync key, fresh for each connection. Others on the network cannot read or change it.
- No analytics, telemetry, or account required.

---

## Requirements

- Obsidian **v1.4.0** or later
- All devices on the **same local network** (same Wi-Fi or Ethernet segment)
- For mobile sync: at least one **desktop device** must be running and reachable on the LAN

---

## Development

```bash
# Clone and install
git clone https://github.com/your-username/obsidian-lan-vault-sync
cd obsidian-lan-vault-sync
npm install

# Development build — watch mode (auto-recompile on save)
npm run dev

# Production build
npm run build

# Run tests
npm test
```

Enable the **Hot Reload** community plugin in Obsidian to automatically reload the plugin after each build.

See [doc/debug-and-testing.md](doc/debug-and-testing.md) for a full multi-device test guide.

---

## Roadmap

- [x] QR code pairing — scan to add a peer instantly (mobile-friendly)
- [ ] End-to-end encryption (TLS / WireGuard)
- [ ] Sync progress indicator per file
- [x] Sync only one folder on a device, which its peers keep to
- [ ] Selective sync with several folders, or different folders per peer
- [ ] Conflict resolution UI for binary files
- [ ] mDNS / Bonjour discovery as alternative to UDP broadcast

---

## Contributing

Pull requests and issues are welcome. Please open an issue before submitting a large PR.

---

## License

[MIT](LICENSE)

---

## Acknowledgements

- [Yjs](https://github.com/yjs/yjs) — CRDT framework by Kevin Jahns
- [ws](https://github.com/websockets/ws) — WebSocket library for Node.js
- [fast-diff](https://github.com/jhchen/fast-diff) — fast string diff
- [Obsidian](https://obsidian.md) — the best local-first knowledge base
