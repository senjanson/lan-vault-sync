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
  encodeAuth,
  encodePing,
  encodePong,
} from './protocol';
import {
  ackMessage,
  authMessage,
  authProof,
  proofsMatch,
  randomNonce,
} from './auth';
import {
  AuthPayload,
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
  /** Pings sent since the peer last sent anything. */
  missedPings: number;
  /** Per-peer message queue to serialize async message handling */
  messageQueue: Promise<void>;
}

type DecodedMessage = ReturnType<typeof decodeMessage>;

/** Result of one handshake step: the peer, a rejection, or "wait for more". */
type HandshakeStep = DeviceInfo | null | 'continue';

export interface AuthFailure {
  deviceName: string;
  address: string;
  /** 'outdated' when the peer runs a version without pairing keys. */
  reason: 'key-mismatch' | 'outdated';
}

/** Unauthenticated sockets are closed after this long. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * A peer that sends nothing for this many pings in a row is taken as gone.
 * A device that sleeps or leaves the network does not close its socket, and
 * until the system notices (which can take many minutes) the peer would stay
 * listed as connected and its reconnection would be refused as a duplicate.
 * Counting ping ticks rather than elapsed time keeps a stalled event loop
 * from dropping a live peer.
 */
const MAX_MISSED_PINGS = 3;

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
  private onAuthFailedCb: ((failure: AuthFailure) => void) | null = null;
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

  /** Called when a device fails the sync key check. */
  onAuthFailed(cb: (failure: AuthFailure) => void): void {
    this.onAuthFailedCb = cb;
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
      const nonce = randomNonce();
      const address = `${device.ip}:${device.port}`;
      this._routeSocket(ws, 'outbound', async (msg) => {
        if (msg.type !== MessageType.HANDSHAKE_ACK) {
          logger.warn(`Expected handshake ack from ${url}, got: ${msg.type}`);
          return null;
        }

        const payload = decodeJSON<HandshakePayload>(msg.payload);
        if (!this._isValidPeer(payload)) {
          logger.warn(`Rejected outbound peer ${payload.deviceId}: invalid handshake ack`);
          return null;
        }

        // The listening side must prove it knows the sync key before we
        // send it anything.
        const key = this.settings.syncKey;
        if (typeof payload.nonce !== 'string' || typeof payload.proof !== 'string') {
          this._authFailed(payload.deviceName, address, 'outdated');
          return null;
        }
        const expected = key
          ? await authProof(key, ackMessage(nonce, payload.nonce, payload.deviceId))
          : '';
        if (!key || !proofsMatch(payload.proof, expected)) {
          this._authFailed(payload.deviceName, address, 'key-mismatch');
          return null;
        }
        ws.send(
          encodeAuth({
            proof: await authProof(key, authMessage(payload.nonce, nonce, this.settings.deviceId)),
          }),
        );

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
      ws.send(encodeHandshake({ ...this.localInfo, nonce }));
    });

    client.connect();
  }

  /** Stop connecting to an address and close outbound connections to it. */
  disconnectAddress(ip: string, port: number): void {
    const client = this.clients.get(`ws://${ip}:${port}`);
    if (client) this._retireClient(client);
    for (const peer of this.peers.values()) {
      if (peer.direction === 'outbound' && peer.ip === ip && peer.port === port) {
        peer.ws.close();
      }
    }
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
    let pending: { device: DeviceInfo; clientNonce: string; serverNonce: string } | null = null;

    this._routeSocket(ws, 'inbound', async (msg): Promise<HandshakeStep> => {
      const key = this.settings.syncKey;

      if (!pending) {
        if (msg.type !== MessageType.HANDSHAKE) {
          logger.warn('Expected handshake, got:', msg.type);
          return null;
        }

        const payload = decodeJSON<HandshakePayload>(msg.payload);
        if (!this._isValidPeer(payload)) {
          logger.warn(`Rejected peer ${payload.deviceId}: invalid handshake`);
          return null;
        }
        if (typeof payload.nonce !== 'string' || payload.nonce.length < 16) {
          this._authFailed(payload.deviceName, ip, 'outdated');
          return null;
        }
        if (!key) return null;

        // Prove we know the key, then wait for the peer to do the same.
        const serverNonce = randomNonce();
        const proof = await authProof(key, ackMessage(payload.nonce, serverNonce, this.settings.deviceId));
        ws.send(encodeHandshakeAck({ ...this.localInfo, nonce: serverNonce, proof }));
        pending = {
          clientNonce: payload.nonce,
          serverNonce,
          device: {
            deviceId: payload.deviceId,
            deviceName: payload.deviceName,
            ip,
            port: payload.port,
            vaultId: payload.vaultId,
            lastSeen: Date.now(),
            acceptsIncomingConnections: this._peerAcceptsIncomingConnections(payload),
          },
        };
        return 'continue';
      }

      if (msg.type !== MessageType.AUTH) {
        logger.warn(`Expected auth from ${pending.device.deviceId}, got:`, msg.type);
        return null;
      }
      const auth = decodeJSON<AuthPayload>(msg.payload);
      const expected = await authProof(
        key,
        authMessage(pending.serverNonce, pending.clientNonce, pending.device.deviceId),
      );
      if (!proofsMatch(auth.proof, expected)) {
        this._authFailed(pending.device.deviceName, ip, 'key-mismatch');
        return null;
      }
      return pending.device;
    });
  }

  private _authFailed(deviceName: string, address: string, reason: AuthFailure['reason']): void {
    logger.warn(`Rejected ${deviceName} (${address}): ${reason}`);
    this.onAuthFailedCb?.({ deviceName: String(deviceName ?? ''), address, reason });
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
    handshake: (msg: DecodedMessage) => HandshakeStep | Promise<HandshakeStep>,
    client?: WSClient,
  ): void {
    let deviceId: string | null = null;
    let rejected = false;
    let chain: Promise<void> = Promise.resolve();

    const timeout = setTimeout(() => {
      if (deviceId === null) ws.close();
    }, HANDSHAKE_TIMEOUT_MS);
    addSocketCloseListener(ws, () => clearTimeout(timeout));

    addSocketMessageListener(ws, (raw) => {
      if (deviceId !== null) {
        const peer = this.peers.get(deviceId);
        if (peer && peer.ws === ws) peer.missedPings = 0;
      }
      chain = chain
        .then(async () => {
          if (rejected) return;
          const msg = decodeMessage(await toUint8Array(raw));
          if (deviceId === null) {
            const step = await handshake(msg);
            if (step === 'continue') return;
            if (!step) {
              rejected = true;
              ws.close();
              return;
            }
            clearTimeout(timeout);
            if (this._setupWs(ws, step, direction, client)) {
              deviceId = step.deviceId;
            } else {
              rejected = true;
            }
            return;
          }
          this._dispatch(deviceId, ws, msg);
        })
        .catch((err) => {
          logger.error(`Error handling message (${direction}):`, err);
          if (deviceId === null) {
            rejected = true;
            ws.close();
          }
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
    const existing = this.peers.get(device.deviceId);
    if (existing) {
      // Both devices may dial each other at the same moment (a manual
      // address on one side, discovery on the other). Each side would then
      // keep its own outgoing socket and close the other one, dropping both.
      // Both sides keep the connection opened by the smaller device ID.
      if (!this._isPreferred(direction, device.deviceId) || this._isPreferred(existing.direction, device.deviceId)) {
        // Close the duplicate. A duplicate outbound client would only keep
        // reconnecting into the same rejection, so retire it; the kept
        // connection has its own reconnect path.
        ws.close();
        if (client) this._retireClient(client);
        return false;
      }
      if (existing.pingTimer) clearInterval(existing.pingTimer);
      this.peers.delete(device.deviceId);
      existing.ws.close();
      if (existing.client) this._retireClient(existing.client);
      this.onPeerDisconnectedCb?.(device.deviceId);
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
      missedPings: 0,
      messageQueue: Promise.resolve(),
    };

    // Ping keepalive; a peer that stops answering is dropped.
    peer.pingTimer = setInterval(() => {
      if (peer.missedPings >= MAX_MISSED_PINGS) {
        logger.warn(`Peer ${device.deviceId} stopped responding; closing the connection`);
        this._removePeer(device.deviceId, ws);
        if (ws.terminate) ws.terminate();
        else ws.close();
        return;
      }
      if (ws.readyState === SOCKET_OPEN) {
        peer.missedPings++;
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

  /** Whether a connection in this direction is the one both sides keep. */
  private _isPreferred(direction: 'inbound' | 'outbound', remoteId: string): boolean {
    return (direction === 'outbound') === (this.settings.deviceId < remoteId);
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
