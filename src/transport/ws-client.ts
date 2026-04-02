import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from "../constants";
import { logger } from "../logger";
import { canUseNodeRuntime } from "../utils/runtime";
import {
  addSocketCloseListener,
  addSocketErrorListener,
  addSocketMessageListener,
  addSocketOpenListener,
  setSocketBinaryType,
  SOCKET_OPEN,
  SocketLike,
  toUint8Array,
} from "./socket";

export class WSClient {
  private ws: SocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private intentionallyClosed = false;

  private onOpenCb: ((ws: SocketLike) => void) | null = null;
  private onMessageCb: ((data: Uint8Array) => void) | null = null;
  private onCloseCb: (() => void) | null = null;

  constructor(private url: string) {}

  onOpen(cb: (ws: SocketLike) => void): void {
    this.onOpenCb = cb;
  }
  onMessage(cb: (data: Uint8Array) => void): void {
    this.onMessageCb = cb;
  }
  onClose(cb: () => void): void {
    this.onCloseCb = cb;
  }

  connect(): void {
    this.intentionallyClosed = false;
    this._doConnect();
  }

  private _doConnect(): void {
    try {
      // Desktop: use ws library (bundled by esbuild, correctly resolved to
      // Node.js entry via wsNodePlugin). Mobile: use native browser WebSocket.
      if (canUseNodeRuntime()) {
        const { WebSocket: WsWebSocket } = require("ws");
        this.ws = new WsWebSocket(this.url) as unknown as SocketLike;
      } else if (globalThis.WebSocket) {
        this.ws = new globalThis.WebSocket(this.url) as unknown as SocketLike;
      } else {
        throw new Error("No WebSocket implementation available");
      }
      setSocketBinaryType(this.ws);

      addSocketOpenListener(this.ws, () => {
        logger.info(`Connected to ${this.url}`);
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.onOpenCb?.(this.ws!);
      });

      addSocketMessageListener(this.ws, async (data) => {
        this.onMessageCb?.(await toUint8Array(data));
      });

      addSocketCloseListener(this.ws, () => {
        logger.info(`Connection closed: ${this.url}`);
        this.onCloseCb?.();
        this._scheduleReconnect();
      });

      addSocketErrorListener(this.ws, (err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`WS client error (${this.url}):`, message);
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
    if (this.ws && this.ws.readyState === SOCKET_OPEN) {
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
    return this.ws?.readyState === SOCKET_OPEN;
  }
}
