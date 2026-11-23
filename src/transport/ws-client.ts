import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from "../constants";
import { logger } from "../logger";
import { canUseNodeRuntime } from "../utils/runtime";
import { loadedWs, loadWs } from "./ws-lib";
import {
  addSocketCloseListener,
  addSocketErrorListener,
  describeSocketError,
  addSocketMessageListener,
  addSocketOpenListener,
  setSocketBinaryType,
  SOCKET_OPEN,
  SocketLike,
  toUint8Array,
} from "./socket";

/**
 * Wait before calling again a device that took the connection but did not
 * pair: another vault, another sync key or an incompatible version. It will
 * refuse again until someone changes something there, so retrying every few
 * seconds only floods both devices' logs. Short enough that a key fixed on
 * the other device takes effect without restarting sync here.
 */
export const REFUSED_RETRY_MS = 2 * 60_000;

export class WSClient {
  private ws: SocketLike | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private intentionallyClosed = false;
  /** Whether the current socket reached the device, and whether it paired. */
  private opened = false;
  private paired = false;
  /** Attempts in a row that did not reach the device at all. */
  failures = 0;
  /** Whether a connection waits for the ws library to load. */
  private loadingWs = false;

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
    // Desktop: the ws library (bundled by esbuild, resolved to its Node.js
    // entry via wsNodePlugin), loaded the first time. Mobile: the WebView's.
    const ws = canUseNodeRuntime() ? loadedWs() : null;
    if (canUseNodeRuntime() && !ws) {
      this._connectOnceLoaded();
      return;
    }
    try {
      if (ws) {
        this.ws = new ws.WebSocket(this.url) as unknown as SocketLike;
      } else if (typeof window.WebSocket === "function") {
        this.ws = new window.WebSocket(this.url) as unknown as SocketLike;
      } else {
        throw new Error("No WebSocket implementation available");
      }
      setSocketBinaryType(this.ws);
      this.opened = false;
      this.paired = false;

      // The backoff is reset in markPaired, not here: a device that takes
      // the connection and then refuses the pairing would otherwise be
      // called again every second for good.
      addSocketOpenListener(this.ws, () => {
        logger.info(`Connected to ${this.url}`);
        this.opened = true;
        this.failures = 0;
        this.onOpenCb?.(this.ws!);
      });

      addSocketMessageListener(this.ws, async (data) => {
        this.onMessageCb?.(await toUint8Array(data));
      });

      addSocketCloseListener(this.ws, () => {
        logger.info(`Connection closed: ${this.url}`);
        if (!this.opened) this.failures++;
        else if (!this.paired) this.reconnectDelay = REFUSED_RETRY_MS;
        this.onCloseCb?.();
        this._scheduleReconnect();
      });

      addSocketErrorListener(this.ws, (err) => {
        const message = describeSocketError(err);
        logger.error(`WS client error (${this.url}):`, message);
        // close event will fire after error
      });
    } catch (err) {
      logger.error(`Failed to connect to ${this.url}:`, err);
      this.failures++;
      this._scheduleReconnect();
    }
  }

  /** Connects once the ws library is loaded; see _doConnect. */
  private _connectOnceLoaded(): void {
    if (this.loadingWs) return;
    this.loadingWs = true;
    loadWs().then(
      () => {
        this.loadingWs = false;
        if (!this.intentionallyClosed) this._doConnect();
      },
      (err: unknown) => {
        this.loadingWs = false;
        logger.error(`Failed to connect to ${this.url}:`, err);
        this.failures++;
        this._scheduleReconnect();
      },
    );
  }

  private _scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    if (this.reconnectTimer) return;

    logger.debug(`Reconnecting to ${this.url} in ${this.reconnectDelay}ms`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this._doConnect();
    }, this.reconnectDelay);

    // A refused device keeps its longer wait.
    if (this.reconnectDelay < RECONNECT_MAX_MS) {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    }
  }

  /** The device on the current socket passed the pairing check. */
  markPaired(): void {
    this.paired = true;
    this.reconnectDelay = RECONNECT_BASE_MS;
  }

  /**
   * Try again right away if a reconnect is waiting, for example when the app
   * comes back to the foreground or the network returns. The backoff can
   * otherwise keep a device waiting up to RECONNECT_MAX_MS.
   */
  reconnectNow(): void {
    if (this.intentionallyClosed || !this.reconnectTimer) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this._doConnect();
  }

  send(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === SOCKET_OPEN) {
      this.ws.send(data);
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
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
