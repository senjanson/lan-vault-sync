import { WSServer } from './ws-server';
import { WSClient } from './ws-client';
import {
  addSocketCloseListener,
  addSocketErrorListener,
  describeSocketError,
  addSocketMessageListener,
  RawSocket,
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
  decodePing,
  decodePong,
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
import { PROTOCOL_VERSION, SEND_BUFFER_LIMIT, SEND_PACE_POLL_MS, WS_PING_INTERVAL_MS } from '../constants';
import { SecureChannel } from './secure-channel';
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
  /** Largest file the peer takes, in bytes, as it said; none for no limit. */
  maxReceiveBytes?: number;
  /** Peer's clock minus ours, in ms, estimated from pings (protocol 3). */
  clockOffsetMs?: number;
  /** Encrypts and decrypts this connection's messages. */
  channel: SecureChannel;
  /** Sends in order: encryption is asynchronous. */
  sendChain: Promise<void>;
  /** Bytes given to _send that are still being encrypted (see bufferedAmount). */
  sealingBytes?: number;
  /** Per-peer message queue to serialize async message handling */
  messageQueue: Promise<void>;
}

type DecodedMessage = ReturnType<typeof decodeMessage>;

interface PairedPeer {
  device: DeviceInfo;
  channel: SecureChannel;
}

/** Result of one handshake step: the paired peer, a rejection, or "wait for more". */
type HandshakeStep = PairedPeer | null | 'continue';

export interface AuthFailure {
  deviceName: string;
  address: string;
  /**
   * 'outdated' when the peer runs an older protocol version, 'newer' when
   * this device does.
   */
  reason: 'key-mismatch' | 'outdated' | 'newer';
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

/** Bytes an incoming connection may send before its pairing messages. */
const PRE_AUTH_MAX_BYTES = 256 * 1024;

/**
 * Failed attempts in a row after which an address added by hand is shown as
 * unreachable (about 7 seconds of retries). A phone without local network
 * permission fails every attempt at once and would otherwise look fine.
 */
const UNREACHABLE_AFTER_FAILURES = 3;

type MessageHandler = (deviceId: string, type: MessageType, payload: Uint8Array) => void | Promise<void>;

export class ConnectionManager {
  private server: WSServer;
  private peers = new Map<string, PeerConnection>();
  /** Outbound clients by URL, including ones that are still (re)connecting. */
  private clients = new Map<string, WSClient>();
  /** Outbound URLs of addresses added by hand; see forgetDiscoveredPeer. */
  private manualUrls = new Set<string>();
  /** Discovered devices reported lost while their connection was still up. */
  private lostUrls = new Set<string>();
  /** Refusals already reported, with their address; see _authFailed. */
  private reportedRefusals = new Map<string, string>();
  private unreachable: string[] = [];
  private onReachabilityChangeCb: (() => void) | null = null;
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
  private onDuplicateDeviceCb: ((deviceName: string) => void) | null = null;

  /**
   * Another device uses this device's ID (its plugin settings were copied
   * with the vault, say). The two cannot sync with each other, and peers
   * would take them for one device; the user has to give one a new ID.
   */
  onDuplicateDevice(cb: (deviceName: string) => void): void {
    this.onDuplicateDeviceCb = cb;
  }

  /** Set this run's instance ID (see DeviceInfo.instance). */
  setInstance(instance: string): void {
    this.localInfo.instance = instance;
  }

  onAuthFailed(cb: (failure: AuthFailure) => void): void {
    this.onAuthFailedCb = cb;
  }

  /** Called when the list of getUnreachablePeers changes. */
  onReachabilityChange(cb: () => void): void {
    this.onReachabilityChangeCb = cb;
  }

  async start(): Promise<void> {
    if (!this.acceptsIncomingConnections) {
      logger.info('Incoming connections are disabled in this runtime; outbound-only mode enabled');
      return;
    }

    this.server.onConnection((ws, ip, raw) => {
      if (raw) this._limitBytesBeforeAuth(ws, raw);
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
    const url = `ws://${device.ip}:${device.port}`;
    // Seen again, so it may be called again once its connection drops.
    this.lostUrls.delete(url);
    if (device.deviceId === this.settings.deviceId) return;
    if (this._livePeer(device.deviceId)) return;
    if (!this._shouldInitiateConnection(device)) return;

    if (device.deviceId.startsWith('manual-')) this.manualUrls.add(url);
    // A manual peer and its auto-discovered entry point at the same address;
    // one client per address is enough.
    if (this.clients.has(url)) return;
    const client = new WSClient(url);
    this.clients.set(url, client);

    client.onClose(() => {
      if (this.clients.get(url) === client && this.lostUrls.delete(url)) this._retireClient(client);
      this._updateReachability();
    });

    client.onOpen((ws) => {
      this._updateReachability();
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
        if (!this._checkVersion(payload, address)) return null;

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
          device: {
            deviceId: payload.deviceId,
            deviceName: payload.deviceName,
            ip: device.ip,
            port: payload.port,
            vaultId: payload.vaultId,
            lastSeen: Date.now(),
            acceptsIncomingConnections: this._peerAcceptsIncomingConnections(payload),
            maxReceiveBytes: typeof payload.maxReceiveBytes === 'number' && payload.maxReceiveBytes > 0 ? payload.maxReceiveBytes : undefined,
          },
          channel: await SecureChannel.derive(key, nonce, payload.nonce, true),
        };
      }, client);
      ws.send(encodeHandshake({ ...this.localInfo, nonce, protocolVersion: PROTOCOL_VERSION, maxReceiveBytes: this.receiveLimitBytes() }));
    });

    client.connect();
  }

  /** Retry every waiting outbound connection now. */
  reconnectNow(): void {
    if (this.stopped) return;
    for (const client of this.clients.values()) client.reconnectNow();
  }

  /**
   * Stop calling a discovered device that discovery no longer sees, so a
   * device that left (or never paired) is not called forever. A connection
   * that is still up is kept but not called again once it closes; discovery
   * reports the device again when it is back. Addresses added by hand keep
   * being called.
   */
  forgetDiscoveredPeer(device: DeviceInfo): void {
    const url = `ws://${device.ip}:${device.port}`;
    const client = this.clients.get(url);
    if (!client || this.manualUrls.has(url)) return;
    if (client.isConnected) this.lostUrls.add(url);
    else this._retireClient(client);
  }

  /**
   * Addresses added by hand that could not be reached several times in a
   * row. They are still being retried.
   */
  getUnreachablePeers(): string[] {
    return this.unreachable;
  }

  /** Stop connecting to an address and close outbound connections to it. */
  disconnectAddress(ip: string, port: number): void {
    this.manualUrls.delete(`ws://${ip}:${port}`);
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
    if (peer) this._send(peer, data);
  }

  /** Broadcast raw bytes to all connected peers */
  broadcast(data: Uint8Array): void {
    for (const peer of this.peers.values()) this._send(peer, data);
  }

  /** Encrypt and send, keeping the order in which messages were given. */
  private _send(peer: PeerConnection, data: Uint8Array): void {
    if (peer.ws.readyState !== SOCKET_OPEN) return;
    const sealed = peer.channel.seal(data);
    peer.sealingBytes = (peer.sealingBytes ?? 0) + data.byteLength;
    peer.sendChain = peer.sendChain
      .then(async () => {
        const frame = await sealed.finally(() => {
          peer.sealingBytes = (peer.sealingBytes ?? 0) - data.byteLength;
        });
        if (peer.ws.readyState === SOCKET_OPEN) peer.ws.send(frame);
      })
      .catch((err) => logger.error(`Failed to send to ${peer.deviceId}:`, err));
  }

  /**
   * Bytes waiting to go to this peer: still being encrypted, or given to the
   * socket and not yet on the network. Both the ws library and the browser
   * WebSocket (used on phones) report the latter as bufferedAmount.
   */
  bufferedAmount(deviceId: string): number {
    const peer = this.peers.get(deviceId);
    return peer ? this._waiting(peer) : 0;
  }

  private _waiting(peer: PeerConnection): number {
    const socket = (peer.ws as { bufferedAmount?: number }).bufferedAmount;
    return (peer.sealingBytes ?? 0) + (typeof socket === 'number' ? socket : 0);
  }

  /**
   * Send messages one at a time, each only once less than `limit` bytes wait
   * to go to the peer, so a large file's chunks are not all held in memory
   * (plain and encrypted) while a slow device takes them. Frames are taken
   * from `frames` only when they can go, so they can be built as needed.
   * Resolves false when the peer disconnects (or its connection is replaced)
   * before everything was sent; the rest is not taken.
   */
  async sendToPaced(
    deviceId: string,
    frames: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    limit = SEND_BUFFER_LIMIT,
  ): Promise<boolean> {
    const peer = this.peers.get(deviceId);
    if (!peer) return false;
    const live = () => !this.stopped && this.peers.get(deviceId) === peer && peer.ws.readyState === SOCKET_OPEN;
    const pause = () => new Promise((resolve) => setTimeout(resolve, SEND_PACE_POLL_MS));
    for await (const frame of frames) {
      // A frame that would go over the limit waits until there is room; one
      // larger than the limit still goes once nothing else waits.
      while (live() && this._waiting(peer) > 0 && this._waiting(peer) + frame.byteLength > limit) await pause();
      if (!live()) return false;
      this._send(peer, frame);
      // Wait here too, so the next frame is not built before it can go.
      while (live() && this._waiting(peer) >= limit) await pause();
    }
    return live();
  }

  /** Largest file to take from a peer, in bytes; 0 for no limit (see maxReceiveMB). */
  receiveLimitBytes(): number {
    const mb = this.settings.maxReceiveMB;
    return typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : 0;
  }

  /** Largest file a peer takes, in bytes, as it said in its handshake; 0 for no limit. */
  peerReceiveLimit(deviceId: string): number {
    return this.peers.get(deviceId)?.maxReceiveBytes ?? 0;
  }

  /** The peer's clock minus ours in ms, once a ping has been answered. */
  getClockOffset(deviceId: string): number | undefined {
    return this.peers.get(deviceId)?.clockOffsetMs;
  }

  getConnectedPeerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  /** The devices connected now, for display. */
  getConnectedPeers(): DeviceInfo[] {
    return Array.from(this.peers.values(), (p) => ({
      deviceId: p.deviceId,
      deviceName: p.deviceName,
      ip: p.ip,
      port: p.port,
      vaultId: p.vaultId,
      lastSeen: Date.now(),
    }));
  }

  isConnectedTo(deviceId: string): boolean {
    return this.peers.get(deviceId)?.ws.readyState === SOCKET_OPEN;
  }

  // ─── Private ────────────────────────────────────────────

  /**
   * Close an incoming connection that sends more than a pairing needs before
   * it has sent its pairing messages. Without this the ws library buffers
   * a single message of up to 100 MB from any device on the network.
   *
   * Counting stops once the handshake and auth messages have arrived (they
   * are emitted before this listener sees the bytes that carried them), so
   * data that follows right behind them is not counted.
   */
  private _limitBytesBeforeAuth(ws: SocketLike, raw: RawSocket): void {
    let bytes = 0;
    let messages = 0;
    const onData = (chunk: { length: number }) => {
      bytes += chunk.length;
      if (bytes > PRE_AUTH_MAX_BYTES) {
        raw.removeListener('data', onData);
        logger.warn('Closing a connection that sent too much data before pairing');
        if (ws.terminate) ws.terminate();
        else ws.close();
      }
    };
    raw.on('data', onData);
    const stopMessages = addSocketMessageListener(ws, () => {
      if (++messages >= 2) {
        raw.removeListener('data', onData);
        stopMessages();
      }
    });
    addSocketCloseListener(ws, () => raw.removeListener('data', onData));
  }

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
        if (!this._checkVersion(payload, ip)) return null;
        if (!key) return null;

        // Prove we know the key, then wait for the peer to do the same.
        const serverNonce = randomNonce();
        const proof = await authProof(key, ackMessage(payload.nonce, serverNonce, this.settings.deviceId));
        ws.send(encodeHandshakeAck({ ...this.localInfo, nonce: serverNonce, proof, protocolVersion: PROTOCOL_VERSION, maxReceiveBytes: this.receiveLimitBytes() }));
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
            maxReceiveBytes: typeof payload.maxReceiveBytes === 'number' && payload.maxReceiveBytes > 0 ? payload.maxReceiveBytes : undefined,
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
      return {
        device: pending.device,
        channel: await SecureChannel.derive(key, pending.clientNonce, pending.serverNonce, false),
      };
    });
  }

  /** Both sides must speak the same protocol; tell the user which to update. */
  private _checkVersion(payload: HandshakePayload, address: string): boolean {
    const version = typeof payload.protocolVersion === 'number' ? payload.protocolVersion : 1;
    if (version === PROTOCOL_VERSION) return true;
    this._authFailed(payload.deviceName, address, version < PROTOCOL_VERSION ? 'outdated' : 'newer');
    return false;
  }

  /**
   * Report a refusal once until that address pairs: the device is retried
   * (and refused again) for as long as nothing changes on either side.
   */
  private _authFailed(deviceName: string, address: string, reason: AuthFailure['reason']): void {
    const key = `${reason} ${address} ${deviceName}`;
    if (this.reportedRefusals.has(key)) {
      logger.debug(`Rejected ${deviceName} (${address}) again: ${reason}`);
      return;
    }
    this.reportedRefusals.set(key, address);
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
    let channel: SecureChannel | null = null;
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
          const bytes = await toUint8Array(raw);
          if (channel) {
            // Paired: everything from here on is encrypted.
            let plain: Uint8Array;
            try {
              plain = await channel.open(bytes);
            } catch (err) {
              logger.warn(`Closing connection with ${deviceId}: message could not be decrypted`, err);
              rejected = true;
              ws.close();
              return;
            }
            this._dispatch(deviceId!, ws, decodeMessage(plain));
            return;
          }
          const msg = decodeMessage(bytes);
          if (deviceId === null) {
            const step = await handshake(msg);
            if (step === 'continue') return;
            if (!step) {
              rejected = true;
              ws.close();
              return;
            }
            clearTimeout(timeout);
            if (this._setupWs(ws, step.device, step.channel, direction, client)) {
              deviceId = step.device.deviceId;
              channel = step.channel;
            } else {
              rejected = true;
            }
          }
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
    channel: SecureChannel,
    direction: 'inbound' | 'outbound',
    client?: WSClient,
  ): boolean {
    if (this.stopped) {
      ws.close();
      return false;
    }
    const existing = this._livePeer(device.deviceId);
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
      maxReceiveBytes: device.maxReceiveBytes,
      channel,
      sendChain: Promise.resolve(),
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
        this._send(peer, encodePing());
      }
    }, WS_PING_INTERVAL_MS);

    this.peers.set(device.deviceId, peer);
    client?.markPaired();
    for (const [key, address] of this.reportedRefusals) {
      if (address === device.ip || address.startsWith(`${device.ip}:`)) this.reportedRefusals.delete(key);
    }

    addSocketCloseListener(ws, () => {
      this._removePeer(device.deviceId, ws);
    });

    addSocketErrorListener(ws, (err) => {
      const message = describeSocketError(err);
      logger.error(`Peer ${device.deviceId} WS error:`, message);
    });

    logger.info(`Peer connected: ${device.deviceId} (${direction}) @ ${device.ip}:${device.port}`);
    this.onPeerConnectedCb?.(device);
    return true;
  }

  private _dispatch(deviceId: string, ws: SocketLike, msg: DecodedMessage): void {
    const p = this.peers.get(deviceId);
    if (!p || p.ws !== ws) return;
    if (msg.type === MessageType.PING) {
      this._send(p, encodePong(decodePing(msg.payload) ?? 0));
      return;
    }
    if (msg.type === MessageType.PONG) {
      const pong = decodePong(msg.payload);
      if (pong && pong.pingTime > 0) {
        const now = Date.now();
        // The peer read its clock about halfway through the round trip.
        p.clockOffsetMs = Math.round(pong.peerTime - (pong.pingTime + now) / 2);
      }
      return;
    }
    if (msg.type === MessageType.HANDSHAKE_ACK) return;

    // Serialize message handling per peer to prevent race conditions.
    // Each message waits for the previous one to finish before starting.
    p.messageQueue = p.messageQueue.then(async () => {
      try {
        await this.messageHandler?.(deviceId, msg.type, msg.payload);
      } catch (err) {
        logger.error(`Error handling message from ${deviceId}:`, err);
      }
    });
  }

  /**
   * The device's connection, if its socket is still open. A socket that is
   * already closing can take a while to report it (the ws library waits up to
   * 30 seconds for the other side). Until then it would count as the device's
   * connection: a new one would be skipped or closed as a duplicate, and once
   * the old socket finally closed nothing would call the device again. So a
   * closing connection is dropped here and a new one may take its place.
   */
  private _livePeer(deviceId: string): PeerConnection | undefined {
    const peer = this.peers.get(deviceId);
    if (!peer) return undefined;
    if (peer.ws.readyState === SOCKET_OPEN) return peer;
    this._removePeer(deviceId, peer.ws);
    return undefined;
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
      if (c === client) {
        this.clients.delete(url);
        this.lostUrls.delete(url);
      }
    }
    this._updateReachability();
  }

  private _updateReachability(): void {
    if (this.stopped) return;
    const unreachable: string[] = [];
    for (const [url, client] of this.clients) {
      if (this.manualUrls.has(url) && client.failures >= UNREACHABLE_AFTER_FAILURES) {
        unreachable.push(url.slice('ws://'.length));
      }
    }
    if (unreachable.join() === this.unreachable.join()) return;
    this.unreachable = unreachable;
    this.onReachabilityChangeCb?.();
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
    if (!payload.deviceId) return false;
    if (payload.deviceId === this.settings.deviceId) {
      if (payload.instance && this.localInfo.instance && payload.instance !== this.localInfo.instance) {
        this.onDuplicateDeviceCb?.(payload.deviceName ?? "");
      }
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
