import type { WebSocket as WsWebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { logger } from '../logger';
import { supportsIncomingConnections } from '../utils/runtime';
import { SocketLike } from './socket';

export class WSServer {
  // Use 'any' for the runtime type since WebSocketServer is loaded via conditional require
  private wss: any = null;
  private onConnectionCb: ((ws: SocketLike, ip: string) => void) | null = null;

  constructor(private port: number) {}

  onConnection(cb: (ws: SocketLike, ip: string) => void): void {
    this.onConnectionCb = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!supportsIncomingConnections()) {
        resolve();
        return;
      }

      // Conditional require so ws module code only runs on desktop (Node/Electron).
      // esbuild still bundles ws (it sees the require('ws') call), but the __commonJS
      // lazy wrapper delays evaluation until this line actually executes.
      const { WebSocketServer } = require('ws');
      this.wss = new WebSocketServer({ port: this.port, host: '0.0.0.0' });

      this.wss.on('listening', () => {
        logger.info(`WebSocket server listening on port ${this.port}`);
        resolve();
      });

      this.wss.on('error', (err: Error) => {
        logger.error('WS Server error:', err);
        reject(err);
      });

      this.wss.on('connection', (ws: WsWebSocket, req: IncomingMessage) => {
        const ip = req.socket.remoteAddress || 'unknown';
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
