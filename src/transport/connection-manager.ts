import { WebSocket } from 'ws';
import { WSServer } from './ws-server';
import { WSClient } from './ws-client';
import {
  decodeMessage,
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
    if (this.peers.has(device.deviceId)) return;

    // Dedup: only the device with the smaller ID initiates
    if (this.settings.deviceId > device.deviceId) return;

    const url = `ws://${device.ip}:${device.port}`;
    const client = new WSClient(url);

    client.onOpen((ws) => {
      // Send handshake
      ws.send(encodeHandshake(this.localInfo));
      this._setupWs(ws, device.deviceId, 'outbound', client, device.ip);
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
      const data = raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

      const msg = decodeMessage(data);
      if (msg.type !== MessageType.HANDSHAKE) {
        logger.warn('Expected handshake, got:', msg.type);
        ws.close();
        return;
      }

      const decoder = new TextDecoder();
      const payload: HandshakePayload = JSON.parse(decoder.decode(msg.payload));

      // Validate same vault
      if (payload.vaultId !== this.vaultId) {
        logger.warn(`Rejected peer ${payload.deviceId}: different vault`);
        ws.close();
        return;
      }

      // Send ack
      ws.send(encodeHandshakeAck(this.localInfo));

      ws.removeListener('message', onFirstMessage);
      this._setupWs(ws, payload.deviceId, 'inbound', undefined, ip);
    };

    ws.on('message', onFirstMessage);
  }

  private _setupWs(ws: WebSocket, deviceId: string, direction: 'inbound' | 'outbound', client?: WSClient, ip?: string): void {
    if (this.peers.has(deviceId)) {
      // Already connected — close duplicate
      ws.close();
      return;
    }

    const peer: PeerConnection = { deviceId, ws, direction, client };

    // Ping keepalive
    peer.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodePing());
      }
    }, WS_PING_INTERVAL_MS);

    this.peers.set(deviceId, peer);

    ws.on('message', (raw: Buffer | ArrayBuffer) => {
      const data = raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const msg = decodeMessage(data);

      if (msg.type === MessageType.PING) {
        ws.send(encodePong());
        return;
      }
      if (msg.type === MessageType.PONG) return;
      if (msg.type === MessageType.HANDSHAKE_ACK) {
        // Handshake complete for outbound
        return;
      }

      this.messageHandler?.(deviceId, msg.type, msg.payload);
    });

    ws.on('close', () => {
      this._removePeer(deviceId);
    });

    ws.on('error', (err) => {
      logger.error(`Peer ${deviceId} WS error:`, err.message);
    });

    logger.info(`Peer connected: ${deviceId} (${direction}) @ ${ip}`);
    this.onPeerConnectedCb?.({
      deviceId,
      deviceName: '',
      ip: ip || '',
      port: 0,
      vaultId: this.vaultId,
      lastSeen: Date.now(),
    });
  }

  private _removePeer(deviceId: string): void {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    if (peer.pingTimer) clearInterval(peer.pingTimer);
    this.peers.delete(deviceId);
    logger.info(`Peer disconnected: ${deviceId}`);
    this.onPeerDisconnectedCb?.(deviceId);
  }
}
