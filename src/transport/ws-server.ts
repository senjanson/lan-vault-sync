import { logger } from '../logger';
import { getDynamicRequire } from '../utils/runtime';
import { SocketLike } from './socket';

export class WSServer {
  private wss: {
    clients: Iterable<SocketLike>;
    close(): void;
    on(event: string, listener: (...args: any[]) => void): void;
  } | null = null;
  private onConnectionCb: ((ws: SocketLike, ip: string) => void) | null = null;

  constructor(private port: number) {}

  onConnection(cb: (ws: SocketLike, ip: string) => void): void {
    this.onConnectionCb = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const require = getDynamicRequire();
      if (!require) {
        resolve();
        return;
      }

      const { WebSocketServer } = require('ws') as {
        WebSocketServer: new (options: { port: number; host: string }) => {
          clients: Iterable<SocketLike>;
          close(): void;
          on(event: string, listener: (...args: any[]) => void): void;
        };
      };
      this.wss = new WebSocketServer({ port: this.port, host: '0.0.0.0' });

      this.wss.on('listening', () => {
        logger.info(`WebSocket server listening on port ${this.port}`);
        resolve();
      });

      this.wss.on('error', (err) => {
        logger.error('WS Server error:', err);
        reject(err);
      });

      this.wss.on('connection', (ws: SocketLike, req: { socket?: { remoteAddress?: string } }) => {
        const ip = req.socket?.remoteAddress || 'unknown';
        logger.info(`Incoming WS connection from ${ip}`);
        this.onConnectionCb?.(ws, ip);
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
