import { WebSocket } from 'ws';
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '../constants';
import { logger } from '../logger';

export class WSClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private intentionallyClosed = false;

  private onOpenCb: ((ws: WebSocket) => void) | null = null;
  private onMessageCb: ((data: Uint8Array) => void) | null = null;
  private onCloseCb: (() => void) | null = null;

  constructor(private url: string) {}

  onOpen(cb: (ws: WebSocket) => void): void { this.onOpenCb = cb; }
  onMessage(cb: (data: Uint8Array) => void): void { this.onMessageCb = cb; }
  onClose(cb: () => void): void { this.onCloseCb = cb; }

  connect(): void {
    this.intentionallyClosed = false;
    this._doConnect();
  }

  private _doConnect(): void {
    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.on('open', () => {
        logger.info(`Connected to ${this.url}`);
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.onOpenCb?.(this.ws!);
      });

      this.ws.on('message', (data: ArrayBuffer | Buffer) => {
        const arr = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.onMessageCb?.(arr);
      });

      this.ws.on('close', () => {
        logger.info(`Connection closed: ${this.url}`);
        this.onCloseCb?.();
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        logger.error(`WS client error (${this.url}):`, err.message);
        // close event will fire after error
      });
    } catch (err) {
      logger.error(`Failed to connect to ${this.url}:`, err);
      this._scheduleReconnect();
    }
  }

  private _scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    if (this.reconnectTimer) return;

    logger.debug(`Reconnecting to ${this.url} in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._doConnect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  send(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
