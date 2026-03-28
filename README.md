# LAN Sync — Obsidian Plugin

Real-time vault synchronization over your local network. Edit on your Mac, see changes instantly on your phone — no cloud required.

## Features

- **Real-time sync** — File changes are pushed to peers within seconds via WebSocket
- **Conflict-free merging** — Text files (Markdown, etc.) use [Yjs](https://github.com/yjs/yjs) CRDT for automatic, character-level conflict resolution
- **Auto-discovery** — Devices find each other via UDP broadcast (zero configuration)
- **Manual peer support** — Add peers by IP:port for networks where broadcast doesn't work
- **Binary file sync** — Images, PDFs, and other attachments sync via hash-based diffing
- **Offline-friendly** — Edit offline, changes merge automatically when you reconnect
- **P2P architecture** — No central server needed; every device is equal

## How It Works

```
Device A (Mac)                        Device B (iPhone)
┌──────────────┐   WebSocket   ┌──────────────┐
│  Obsidian    │◄────────────►│  Obsidian    │
│  + LAN Sync  │   Yjs CRDT   │  + LAN Sync  │
└──────────────┘    updates    └──────────────┘
```

1. Each device runs a WebSocket server and broadcasts its presence via UDP
2. Devices auto-connect and exchange file tree metadata
3. Text files sync via Yjs CRDT (character-level merge, no conflicts)
4. Binary files sync via hash comparison (last-write-wins for conflicts)

## Installation

### From Obsidian Community Plugins (coming soon)

1. Open **Settings → Community Plugins → Browse**
2. Search for "LAN Sync"
3. Install and enable

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/your-username/obsidian-lan-sync/releases)
2. Create folder: `<your-vault>/.obsidian/plugins/lan-sync/`
3. Copy the three files into that folder
4. Restart Obsidian and enable the plugin in **Settings → Community Plugins**

## Usage

### Quick Start

1. Install the plugin on **two or more devices** on the same local network
2. Open the same vault name on each device
3. The plugin auto-discovers peers and begins syncing

### Manual Peer Connection

If auto-discovery doesn't work (common on some Wi-Fi networks or mobile):

1. On **Device A**: go to plugin settings, note the IP address and port (default: `53712`)
2. On **Device B**: go to plugin settings → Manual Peers → add `192.168.x.x:53712`
3. Or use the command palette: **LAN Sync: Add Manual Peer**

### Settings

| Setting | Default | Description |
|---|---|---|
| Enable Sync | On | Master on/off switch |
| Device Name | Auto-generated | Friendly name shown to other peers |
| Port | 53712 | WebSocket listening port |
| Ignored Paths | `.obsidian/`, `.trash/` | Paths excluded from sync |
| Sync Check Interval | 30s | Periodic full-sync verification interval |
| Debug Logging | Off | Verbose logs in developer console |

### Commands

- **Toggle LAN Sync** — Start/stop the sync service
- **Open Sync Panel** — Open the sidebar panel showing connected devices and sync log
- **Add Manual Peer** — Add a peer by IP:port

## Technical Details

### Architecture

- **Transport**: WebSocket (P2P, each node is both server and client)
- **Text Sync**: Yjs CRDT with `fast-diff` for efficient delta computation
- **Binary Sync**: SHA-256 hash comparison, full file transfer on mismatch
- **Discovery**: UDP broadcast on port 53713 (configurable)
- **Persistence**: CRDT state saved to `.obsidian/plugins/lan-sync/crdt-state/`

### Conflict Resolution

| File Type | Strategy |
|---|---|
| Text (.md, .txt, etc.) | Yjs CRDT — automatic, lossless merge at character level |
| Binary (images, PDF, etc.) | Last-write-wins (by modification time) |

### Mobile Compatibility

- Mobile devices act as WebSocket **clients** (cannot run a server)
- Auto-discovery may not work on mobile — use manual peer entry
- Sync resumes automatically when the app returns to foreground

## Requirements

- Obsidian v1.4.0+
- All devices on the same local network (Wi-Fi / Ethernet)
- For mobile: desktop device must be running and reachable

## Development

```bash
# Install dependencies
npm install

# Development build (watch mode)
npm run dev

# Production build
npm run build

# Run tests
npm test
```

## License

MIT
