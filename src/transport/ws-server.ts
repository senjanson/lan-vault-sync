import type { WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import { logger } from '../logger';
import { supportsIncomingConnections } from '../utils/runtime';
import { RawSocket, SocketLike } from './socket';
import { loadWs } from './ws-lib';

/** The parts of Node's IncomingMessage the server reads. */
interface IncomingRequest {
  socket: { remoteAddress?: string };
}

export class WSServer {
  private wss: WebSocketServer | null = null;
  private onConnectionCb: ((ws: SocketLike, ip: string, raw?: RawSocket) => void) | null = null;

  constructor(private port: number) {}

  onConnection(cb: (ws: SocketLike, ip: string, raw?: RawSocket) => void): void {
    this.onConnectionCb = cb;
  }

  async start(): Promise<void> {
    if (!supportsIncomingConnections()) return;

    // Loaded here, so the ws library only runs on desktop (Node/Electron).
    const { WebSocketServer } = await loadWs();
    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.port, host: '0.0.0.0' });
      this.wss = wss;

      wss.on('listening', () => {
        logger.info(`WebSocket server listening on port ${this.port}`);
        resolve();
      });

      wss.on('error', (err: Error) => {
        logger.error('WS Server error:', err);
        reject(err);
      });

      wss.on('connection', (ws: WsWebSocket, req: IncomingRequest) => {
        const ip = req.socket.remoteAddress || 'unknown';
        logger.info(`Incoming WS connection from ${ip}`);
        this.onConnectionCb?.(ws as unknown as SocketLike, ip, req.socket as unknown as RawSocket);
      });
    });
  }

  stop(): void {
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
      logger.info('WebSocket server stopped');
    }
  }
}
