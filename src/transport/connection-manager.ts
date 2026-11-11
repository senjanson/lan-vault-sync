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

type DecodedMessage = ReturnType<typeof decodeMessage>;

type MessageHandler = (deviceId: string, type: MessageType, payload: Uint8Array) => void | Promise<void>;

export class ConnectionManager {
  private server: WSServer;
  private peers = new Map<string, PeerConnection>();
  /** Outbound clients by URL, including ones that are still (re)connecting. */
  private clients = new Map<string, WSClient>();
  private stopped = false;
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
    this.stopped = true;
    for (const [, peer] of this.peers) {
      if (peer.pingTimer) clearInterval(peer.pingTimer);
      peer.ws.close();
    }
    this.peers.clear();
    // Also close clients that are not connected yet; otherwise their reconnect
    // timers keep running and sync resumes after the service was stopped.
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.server.stop();
  }

  /** Connect to a discovered peer. Dedup: lower deviceId connects first. */
  connectToPeer(device: DeviceInfo): void {
    if (device.deviceId === this.settings.deviceId) return;
    if (this.peers.has(device.deviceId)) return;
    if (!this._shouldInitiateConnection(device)) return;

    const url = `ws://${device.ip}:${device.port}`;
    // A manual peer and its auto-discovered entry point at the same address;
    // one client per address is enough.
    if (this.clients.has(url)) return;
    const client = new WSClient(url);
    this.clients.set(url, client);

    client.onOpen((ws) => {
      this._routeSocket(ws, 'outbound', (msg) => {
        if (msg.type !== MessageType.HANDSHAKE_ACK) {
          logger.warn(`Expected handshake ack from ${url}, got: ${msg.type}`);
          return null;
        }

        const payload = decodeJSON<HandshakePayload>(msg.payload);
        if (!this._isValidPeer(payload)) {
          logger.warn(`Rejected outbound peer ${payload.deviceId}: invalid handshake ack`);
          return null;
        }

        return {
          deviceId: payload.deviceId,
          deviceName: payload.deviceName,
          ip: device.ip,
          port: payload.port,
          vaultId: payload.vaultId,
          lastSeen: Date.now(),
          acceptsIncomingConnections: this._peerAcceptsIncomingConnections(payload),
        };
      }, client);
      ws.send(encodeHandshake(this.localInfo));
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
    this._routeSocket(ws, 'inbound', (msg) => {
      if (msg.type !== MessageType.HANDSHAKE) {
        logger.warn('Expected handshake, got:', msg.type);
        return null;
      }

      const payload = decodeJSON<HandshakePayload>(msg.payload);
      if (!this._isValidPeer(payload)) {
        logger.warn(`Rejected peer ${payload.deviceId}: invalid handshake`);
        return null;
      }

      ws.send(encodeHandshakeAck(this.localInfo));
      return {
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
        ip,
        port: payload.port,
        vaultId: payload.vaultId,
        lastSeen: Date.now(),
        acceptsIncomingConnections: this._peerAcceptsIncomingConnections(payload),
      };
    });
  }

  /**
   * Handle every message of a socket through one ordered listener: the first
   * message completes the handshake, later ones go to the peer.
   *
   * A single listener matters because `ws` emits all messages contained in one
   * TCP chunk synchronously. With a separate handshake listener, the peer's
   * first data message (sent right behind the ack) reached the handshake
   * listener before it could unregister, which closed the connection and
   * started an endless reconnect loop.
   */
  private _routeSocket(
    ws: SocketLike,
    direction: 'inbound' | 'outbound',
    handshake: (msg: DecodedMessage) => DeviceInfo | null,
    client?: WSClient,
  ): void {
    let deviceId: string | null = null;
    let chain: Promise<void> = Promise.resolve();

    addSocketMessageListener(ws, (raw) => {
      chain = chain
        .then(async () => {
          const msg = decodeMessage(await toUint8Array(raw));
          if (deviceId === null) {
            const device = handshake(msg);
            if (!device) {
              ws.close();
              return;
            }
            if (this._setupWs(ws, device, direction, client)) {
              deviceId = device.deviceId;
            }
            return;
          }
          this._dispatch(deviceId, ws, msg);
        })
        .catch((err) => {
          logger.error(`Error handling message (${direction}):`, err);
        });
    });
  }

  private _setupWs(
    ws: SocketLike,
    device: DeviceInfo,
    direction: 'inbound' | 'outbound',
    client?: WSClient,
  ): boolean {
    if (this.stopped) {
      ws.close();
      return false;
    }
    if (this.peers.has(device.deviceId)) {
      // Already connected — close the duplicate. A duplicate outbound client
      // would only keep reconnecting into the same rejection, so retire it;
      // the existing connection has its own reconnect path.
      ws.close();
      if (client) this._retireClient(client);
      return false;
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

    addSocketCloseListener(ws, () => {
      this._removePeer(device.deviceId, ws);
    });

    addSocketErrorListener(ws, (err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Peer ${device.deviceId} WS error:`, message);
    });

    logger.info(`Peer connected: ${device.deviceId} (${direction}) @ ${device.ip}:${device.port}`);
    this.onPeerConnectedCb?.(device);
    return true;
  }

  private _dispatch(deviceId: string, ws: SocketLike, msg: DecodedMessage): void {
    if (msg.type === MessageType.PING) {
      ws.send(encodePong());
      return;
    }
    if (msg.type === MessageType.PONG || msg.type === MessageType.HANDSHAKE_ACK) return;

    // Serialize message handling per peer to prevent race conditions.
    // Each message waits for the previous one to finish before starting.
    const p = this.peers.get(deviceId);
    if (!p || p.ws !== ws) return;
    p.messageQueue = p.messageQueue.then(async () => {
      try {
        await this.messageHandler?.(deviceId, msg.type, msg.payload);
      } catch (err) {
        logger.error(`Error handling message from ${deviceId}:`, err);
      }
    });
  }

  /**
   * Forget a peer when its socket closes. Only the socket that is registered
   * for the device may remove it: a closing duplicate must not drop the live
   * connection that replaced or preceded it.
   */
  private _removePeer(deviceId: string, ws: SocketLike): void {
    const peer = this.peers.get(deviceId);
    if (!peer || peer.ws !== ws) return;
    if (peer.pingTimer) clearInterval(peer.pingTimer);
    this.peers.delete(deviceId);
    logger.info(`Peer disconnected: ${deviceId}`);
    this.onPeerDisconnectedCb?.(deviceId);
  }

  private _retireClient(client: WSClient): void {
    client.close();
    for (const [url, c] of this.clients) {
      if (c === client) this.clients.delete(url);
    }
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
