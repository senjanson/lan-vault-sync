type SocketBinaryType = BinaryType | 'nodebuffer' | 'fragments';

export interface SocketLike {
  readyState: number;
  binaryType?: SocketBinaryType;
  send(data: Uint8Array): void;
  close(): void;
  /** Drop the connection at once, without a closing handshake (ws only). */
  terminate?(): void;
  addEventListener?(event: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener?(event: string, listener: EventListenerOrEventListenerObject): void;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}

export const SOCKET_OPEN = 1;

export function setSocketBinaryType(socket: SocketLike): void {
  try {
    socket.binaryType = 'arraybuffer';
  } catch {
    // Some Node socket wrappers expose binaryType as readonly.
  }
}

export function addSocketOpenListener(socket: SocketLike, listener: () => void): () => void {
  return addSocketListener(socket, 'open', listener);
}

export function addSocketCloseListener(socket: SocketLike, listener: () => void): () => void {
  return addSocketListener(socket, 'close', listener);
}

export function addSocketErrorListener(socket: SocketLike, listener: (error: unknown) => void): () => void {
  return addSocketListener(socket, 'error', listener);
}

export function addSocketMessageListener(
  socket: SocketLike,
  listener: (data: unknown) => void | Promise<void>,
): () => void {
  if (socket.addEventListener) {
    const wrapped = ((event: Event) => {
      void listener((event as MessageEvent).data);
    }) as EventListener;
    socket.addEventListener('message', wrapped);
    return () => socket.removeEventListener?.('message', wrapped);
  }

  if (socket.on) {
    const wrapped = (data: unknown) => {
      void listener(data);
    };
    socket.on('message', wrapped);
    return () => socket.removeListener?.('message', wrapped);
  }

  throw new Error('Unsupported WebSocket implementation');
}

export async function toUint8Array(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    // Node Buffers are Uint8Arrays whose slice() shares memory; normalise to a
    // plain view so later slice() calls copy as callers expect.
    return data.constructor === Uint8Array
      ? data
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }

  throw new Error(`Unsupported WebSocket message payload: ${typeof data}`);
}

function addSocketListener(
  socket: SocketLike,
  event: string,
  listener: (...args: any[]) => void,
): () => void {
  if (socket.addEventListener) {
    const wrapped = ((...args: any[]) => listener(...args)) as EventListener;
    socket.addEventListener(event, wrapped);
    return () => socket.removeEventListener?.(event, wrapped);
  }

  if (socket.on) {
    socket.on(event, listener);
    return () => socket.removeListener?.(event, listener);
  }

  throw new Error('Unsupported WebSocket implementation');
}

