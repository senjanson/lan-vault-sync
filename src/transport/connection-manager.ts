import { WebSocket } from 'ws';
import { WSServer } from './ws-server';
import { WSClient } from './ws-client';
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

interface PeerConnection {
  deviceId: string;
  deviceName: string;
  ip: string;
  port: number;
  vaultId: string;
  ws: WebSocket;
  direction: 'inbound' | 'outbound';
  client?: WSClient;
  pingTimer?: ReturnType<typeof setInterval>;
}

type MessageHandler = (deviceId: string, type: MessageType, payload: Uint8Array) => void;

export class ConnectionManager {
  private server: WSServer;
  private peers = new Map<string, PeerConnection>();
  private messageHandler: MessageHandler | null = null;
  private localInfo: HandshakePayload;
  private onPeerConnectedCb: ((device: DeviceInfo) => void) | null = null;
  private onPeerDisconnectedCb: ((deviceId: string) => void) | null = null;

  constructor(private settings: LANSyncSettings, private vaultId: string) {
    this.server = new WSServer(settings.port);
    this.localInfo = {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      vaultId: this.vaultId,
      port: settings.port,
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
      const onHandshakeAck = (raw: Buffer | ArrayBuffer) => {
        const msg = decodeMessage(this._toUint8Array(raw));
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

        ws.removeListener('message', onHandshakeAck);
        this._setupWs(ws, {
          deviceId: payload.deviceId,
          deviceName: payload.deviceName,
          ip: device.ip,
          port: payload.port,
          vaultId: payload.vaultId,
          lastSeen: Date.now(),
        }, 'outbound', client);
      };

      ws.on('message', onHandshakeAck);
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
    if (peer && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(data);
    }
  }

  /** Broadcast raw bytes to all connected peers */
  broadcast(data: Uint8Array): void {
    for (const [, peer] of this.peers) {
      if (peer.ws.readyState === WebSocket.OPEN) {
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

  private _handleInbound(ws: WebSocket, ip: string): void {
    // Wait for handshake first message
    const onFirstMessage = (raw: Buffer | ArrayBuffer) => {
      const msg = decodeMessage(this._toUint8Array(raw));
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

      ws.removeListener('message', onFirstMessage);
      this._setupWs(ws, {
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
        ip,
        port: payload.port,
        vaultId: payload.vaultId,
        lastSeen: Date.now(),
      }, 'inbound');
    };

    ws.on('message', onFirstMessage);
  }

  private _setupWs(
    ws: WebSocket,
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
    };

    // Ping keepalive
    peer.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodePing());
      }
    }, WS_PING_INTERVAL_MS);

    this.peers.set(device.deviceId, peer);

    ws.on('message', (raw: Buffer | ArrayBuffer) => {
      try {
        const msg = decodeMessage(this._toUint8Array(raw));

        if (msg.type === MessageType.PING) {
          ws.send(encodePong());
          return;
        }
        if (msg.type === MessageType.PONG) return;
        if (msg.type === MessageType.HANDSHAKE_ACK) {
          // Handshake complete for outbound
          return;
        }

        const result = this.messageHandler?.(device.deviceId, msg.type, msg.payload);
        if (result && typeof (result as any).catch === 'function') {
          (result as Promise<void>).catch(err => logger.error(`Error handling message from ${device.deviceId}:`, err));
        }
      } catch (err) {
        logger.error(`Error decoding message from ${device.deviceId}:`, err);
      }
    });

    ws.on('close', () => {
      this._removePeer(device.deviceId);
    });

    ws.on('error', (err) => {
      logger.error(`Peer ${device.deviceId} WS error:`, err.message);
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

  private _toUint8Array(raw: Buffer | ArrayBuffer): Uint8Array {
    return raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
}
