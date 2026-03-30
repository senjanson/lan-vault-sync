import { WSServer } from './ws-server';
import { WSClient } from './ws-client';
import {
  addSocketCloseListener,
  addSocketErrorListener,
  addSocketMessageListener,
  SOCKET_OPEN,
  SocketLike,
  toUint8Array,
} from './socket';
import {
  decodeMessage,
  decodeJSON,
  encodeHandshake,
  encodeHandshakeAck,
  encodePing,
  encodePong,
} from './protocol';
import {
  DeviceInfo,
  HandshakePayload,
  MessageType,
  LANSyncSettings,
} from '../types';
import { WS_PING_INTERVAL_MS } from '../constants';
import { logger } from '../logger';
import { supportsIncomingConnections } from '../utils/runtime';

interface PeerConnection {
  deviceId: string;
  deviceName: string;
  ip: string;
  port: number;
  vaultId: string;
  ws: SocketLike;
  direction: 'inbound' | 'outbound';
  client?: WSClient;
  pingTimer?: ReturnType<typeof setInterval>;
  /** Per-peer message queue to serialize async message handling */
  messageQueue: Promise<void>;
}

type MessageHandler = (deviceId: string, type: MessageType, payload: Uint8Array) => void | Promise<void>;

export class ConnectionManager {
  private server: WSServer;
  private peers = new Map<string, PeerConnection>();
  private messageHandler: MessageHandler | null = null;
  private localInfo: HandshakePayload;
  private onPeerConnectedCb: ((device: DeviceInfo) => void) | null = null;
  private onPeerDisconnectedCb: ((deviceId: string) => void) | null = null;
  private readonly acceptsIncomingConnections: boolean;

  constructor(private settings: LANSyncSettings, private vaultId: string) {
    this.server = new WSServer(settings.port);
    this.acceptsIncomingConnections = supportsIncomingConnections();
    this.localInfo = {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      vaultId: this.vaultId,
      port: settings.port,
      acceptsIncomingConnections: this.acceptsIncomingConnections,
    };
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onPeerConnected(cb: (device: DeviceInfo) => void): void {
    this.onPeerConnectedCb = cb;
  }

  onPeerDisconnected(cb: (deviceId: string) => void): void {
    this.onPeerDisconnectedCb = cb;
  }

  async start(): Promise<void> {
    if (!this.acceptsIncomingConnections) {
      logger.info('Incoming connections are disabled in this runtime; outbound-only mode enabled');
      return;
    }

    this.server.onConnection((ws, ip) => {
      this._handleInbound(ws, ip);
    });
    await this.server.start();
  }

  stop(): void {
    for (const [, peer] of this.peers) {
      if (peer.pingTimer) clearInterval(peer.pingTimer);
      peer.client?.close();
      peer.ws.close();
    }
    this.peers.clear();
    this.server.stop();
  }

  /** Connect to a discovered peer. Dedup: lower deviceId connects first. */
  connectToPeer(device: DeviceInfo): void {
    if (device.deviceId === this.settings.deviceId) return;
    if (this.peers.has(device.deviceId)) return;
    if (!this._shouldInitiateConnection(device)) return;

    const url = `ws://${device.ip}:${device.port}`;
    const client = new WSClient(url);

    client.onOpen((ws) => {
      const offHandshakeAck = addSocketMessageListener(ws, async (raw) => {
        const msg = decodeMessage(await toUint8Array(raw));
        if (msg.type !== MessageType.HANDSHAKE_ACK) {
          logger.warn(`Expected handshake ack from ${url}, got: ${msg.type}`);
          ws.close();
          return;
        }

        const payload = decodeJSON<HandshakePayload>(msg.payload);
        if (!this._isValidPeer(payload)) {
          logger.warn(`Rejected outbound peer ${payload.deviceId}: invalid handshake ack`);
          ws.close();
          return;
        }

        offHandshakeAck();
        this._setupWs(ws, {
          deviceId: payload.deviceId,
          deviceName: payload.deviceName,
          ip: device.ip,
          port: payload.port,
          vaultId: payload.vaultId,
          lastSeen: Date.now(),
          acceptsIncomingConnections: this._peerAcceptsIncomingConnections(payload),
        }, 'outbound', client);
      });
      ws.send(encodeHandshake(this.localInfo));
    });

    client.onClose(() => {
      this._removePeer(device.deviceId);
    });

    client.connect();
  }

  /** Send raw bytes to a specific peer */
  sendTo(deviceId: string, data: Uint8Array): void {
    const peer = this.peers.get(deviceId);
    if (peer && peer.ws.readyState === SOCKET_OPEN) {
      peer.ws.send(data);
    }
  }

  /** Broadcast raw bytes to all connected peers */
  broadcast(data: Uint8Array): void {
    for (const [, peer] of this.peers) {
      if (peer.ws.readyState === SOCKET_OPEN) {
        peer.ws.send(data);
      }
    }
  }

  getConnectedPeerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  isConnectedTo(deviceId: string): boolean {
    return this.peers.has(deviceId);
  }

  // ─── Private ────────────────────────────────────────────

  private _handleInbound(ws: SocketLike, ip: string): void {
    // Wait for handshake first message
    const offFirstMessage = addSocketMessageListener(ws, async (raw) => {
      const msg = decodeMessage(await toUint8Array(raw));
      if (msg.type !== MessageType.HANDSHAKE) {
        logger.warn('Expected handshake, got:', msg.type);
        ws.close();
        return;
      }

      const payload = decodeJSON<HandshakePayload>(msg.payload);
      if (!this._isValidPeer(payload)) {
        logger.warn(`Rejected peer ${payload.deviceId}: invalid handshake`);
        ws.close();
        return;
      }

      // Send ack
      ws.send(encodeHandshakeAck(this.localInfo));

      offFirstMessage();
      this._setupWs(ws, {
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
        ip,
        port: payload.port,
        vaultId: payload.vaultId,
        lastSeen: Date.now(),
        acceptsIncomingConnections: this._peerAcceptsIncomingConnections(payload),
      }, 'inbound');
    });
  }

  private _setupWs(
    ws: SocketLike,
    device: DeviceInfo,
    direction: 'inbound' | 'outbound',
    client?: WSClient,
  ): void {
    if (this.peers.has(device.deviceId)) {
      // Already connected — close duplicate
      ws.close();
      return;
    }

    const peer: PeerConnection = {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      ip: device.ip,
      port: device.port,
      vaultId: device.vaultId,
      ws,
      direction,
      client,
      messageQueue: Promise.resolve(),
    };

    // Ping keepalive
    peer.pingTimer = setInterval(() => {
      if (ws.readyState === SOCKET_OPEN) {
        ws.send(encodePing());
      }
    }, WS_PING_INTERVAL_MS);

    this.peers.set(device.deviceId, peer);

    addSocketMessageListener(ws, async (raw) => {
      try {
        const msg = decodeMessage(await toUint8Array(raw));

        if (msg.type === MessageType.PING) {
          ws.send(encodePong());
          return;
        }
        if (msg.type === MessageType.PONG) return;
        if (msg.type === MessageType.HANDSHAKE_ACK) {
          // Handshake complete for outbound
          return;
        }

        // Serialize message handling per peer to prevent race conditions.
        // Each message waits for the previous one to finish before starting.
        const p = this.peers.get(device.deviceId);
        if (p) {
          p.messageQueue = p.messageQueue.then(async () => {
            try {
              await this.messageHandler?.(device.deviceId, msg.type, msg.payload);
            } catch (err) {
              logger.error(`Error handling message from ${device.deviceId}:`, err);
            }
          });
        }
      } catch (err) {
        logger.error(`Error decoding message from ${device.deviceId}:`, err);
      }
    });

    addSocketCloseListener(ws, () => {
      this._removePeer(device.deviceId);
    });

    addSocketErrorListener(ws, (err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Peer ${device.deviceId} WS error:`, message);
    });

    logger.info(`Peer connected: ${device.deviceId} (${direction}) @ ${device.ip}:${device.port}`);
    this.onPeerConnectedCb?.(device);
  }

  private _removePeer(deviceId: string): void {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    if (peer.pingTimer) clearInterval(peer.pingTimer);
    this.peers.delete(deviceId);
    logger.info(`Peer disconnected: ${deviceId}`);
    this.onPeerDisconnectedCb?.(deviceId);
  }

  private _shouldInitiateConnection(device: DeviceInfo): boolean {
    if (!this._peerAcceptsIncomingConnections(device)) {
      return false;
    }

    if (!this.acceptsIncomingConnections) {
      return true;
    }

    if (device.deviceId.startsWith('manual-')) {
      return true;
    }

    // Dedup: only the device with the smaller ID initiates
    return this.settings.deviceId <= device.deviceId;
  }

  private _isValidPeer(payload: HandshakePayload): boolean {
    if (!payload.deviceId || payload.deviceId === this.settings.deviceId) {
      return false;
    }
    if (payload.vaultId !== this.vaultId) {
      return false;
    }
    if (!Number.isInteger(payload.port) || payload.port <= 0 || payload.port > 65535) {
      return false;
    }
    return true;
  }

  private _peerAcceptsIncomingConnections(
    peer: Pick<DeviceInfo, 'acceptsIncomingConnections'> | Pick<HandshakePayload, 'acceptsIncomingConnections'>,
  ): boolean {
    return peer.acceptsIncomingConnections !== false;
  }
}
