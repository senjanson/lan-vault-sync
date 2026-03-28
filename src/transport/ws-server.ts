import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { logger } from '../logger';

export class WSServer {
  private wss: WebSocketServer | null = null;
  private onConnectionCb: ((ws: WebSocket, ip: string) => void) | null = null;

  constructor(private port: number) {}

  onConnection(cb: (ws: WebSocket, ip: string) => void): void {
    this.onConnectionCb = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port, host: '0.0.0.0' });

      this.wss.on('listening', () => {
        logger.info(`WebSocket server listening on port ${this.port}`);
        resolve();
      });

      this.wss.on('error', (err) => {
        logger.error('WS Server error:', err);
        reject(err);
      });

      this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
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
