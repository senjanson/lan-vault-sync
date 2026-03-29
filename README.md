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
| **Binary file sync** | Images, PDFs, and other attachments synced via SHA-256 hash comparison |
| **Auto-discovery** | Devices find each other via UDP broadcast — zero configuration needed |
| **Manual peers** | Add peers by `IP:port` for networks where broadcast is blocked |
| **QR code pairing** | Generate a QR code on desktop; scan with your phone to add the peer instantly — no typing required |
| **Offline-friendly** | Edit while offline; changes are merged automatically on reconnect |
| **P2P architecture** | Every device is equal — no central server or hub required |
| **Conflict backups** | Binary-file conflicts are backed up before overwrite so nothing is lost |

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

---

## Usage

### Quick Start

1. Install the plugin on **two or more devices** connected to the same Wi-Fi or LAN.
2. Open Obsidian on each device.
3. The plugin automatically discovers peers and begins syncing within seconds.

### QR Code Pairing (Recommended for Mobile)

The easiest way to connect a phone or tablet — no typing required:

1. On the **desktop (Mac / Windows / Linux)**: open **Settings → LAN Vault Sync** and find the **QR Code Pairing** section. A QR code is displayed automatically.
2. On your **phone / tablet**: scan the QR code with the system camera (or any QR scanner).
3. The camera will prompt you to open Obsidian. Confirm — the plugin automatically adds the desktop's IP:port as a peer and shows a notification.

> **Tip:** If your desktop has multiple network interfaces (e.g. Wi-Fi + Ethernet), use the dropdown above the QR code to select the correct IP before scanning.

### Manual Peer Connection

Auto-discovery uses UDP broadcast, which is blocked on some managed Wi-Fi networks (guest networks, corporate networks). In that case:

1. On **Device A**: open plugin settings and note the displayed **IP address** and **port** (default: `53712`).
2. On **Device B**: go to **Settings → LAN Vault Sync → Manual Peers** → enter `192.168.x.x:53712`.
3. Alternatively, use the command palette: **LAN Vault Sync: Add Manual Peer**.

### Status Bar

The plugin shows a status indicator in the Obsidian status bar:

| Icon | Meaning |
|---|---|
| 🔴 | Sync disabled or no peers found |
| 🟡 | Discovering peers |
| 🟢 | Connected and syncing |

### Commands

Open the command palette (`Cmd/Ctrl + P`) and search for:

- **LAN Vault Sync: Toggle** — start or stop the sync service
- **LAN Vault Sync: Open Sync Panel** — open the sidebar panel with connected peers and sync log
- **LAN Vault Sync: Add Manual Peer** — add a peer by `IP:port`

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Enable Sync | On | Master on/off switch |
| Device Name | Auto-generated | Friendly name shown to other peers |
| Port | `53712` | WebSocket listening port |
| Ignored Paths | `.obsidian/`, `.trash/` | Glob patterns excluded from sync |
| Sync Check Interval | `30s` | Period between full file-tree verification passes |
| Debug Logging | Off | Write verbose logs to the developer console |

---

## Technical Details

### Architecture

- **Topology**: Peer-to-peer mesh — each node runs a WebSocket server and connects to every known peer as a client
- **Text sync**: [Yjs](https://github.com/yjs/yjs) CRDT with [`fast-diff`](https://github.com/jhchen/fast-diff) for efficient delta computation
- **Binary sync**: SHA-256 hash comparison; full file transferred when hashes differ
- **Discovery**: UDP broadcast on port `53713` (same subnet only)
- **CRDT persistence**: Yjs document states saved to `.obsidian/plugins/lan-vault-sync/crdt-state/`
- **Conflict backups**: Overwritten binary files backed up to `.obsidian/plugins/lan-vault-sync/conflicts/`

### Conflict Resolution

| File type | Strategy |
|---|---|
| Text (`.md`, `.txt`, `.canvas`, …) | Yjs CRDT — automatic, **lossless** merge at character level |
| Binary (images, PDFs, audio, …) | Last-write-wins by modification timestamp; previous version backed up |

### Mobile Compatibility

- Mobile devices (iOS / Android) act as WebSocket **clients** only — they cannot run a server due to OS restrictions.
- A desktop device must be reachable on the network to act as a server for mobile clients.
- Auto-discovery may not work on mobile; use **QR Code Pairing** or **Manual Peers** as a fallback.
- Sync resumes automatically when the Obsidian app returns to the foreground.

### Privacy & Security

- All traffic is **LAN-only**. No data is sent to any external server.
- Communication is plain WebSocket (`ws://`) within your local network. Do not enable this plugin on public or untrusted networks.
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
- [ ] Selective sync (include/exclude folders per peer)
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
