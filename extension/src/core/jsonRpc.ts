import { RpcErrorCodes } from './analyzerProtocol';

/** Error answer of a JSON-RPC request. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }

  /** Cancelled, superseded by a newer request, or stopped by shutdown (-32800). */
  get isCancellation(): boolean {
    return this.code === RpcErrorCodes.cancelled;
  }

  /** `data.reason` of a -32800 error: "cancelled" | "superseded" | "shutdown". */
  get cancelReason(): string | undefined {
    const data = this.data as { reason?: unknown } | undefined;
    return typeof data?.reason === 'string' ? data.reason : undefined;
  }
}

/** The connection was closed (process exit) before the answer arrived. */
export class ConnectionClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionClosedError';
  }
}

export interface PendingRequest<T> {
  readonly id: number;
  readonly result: Promise<T>;
}

type NotificationHandler = (method: string, params: unknown) => void;

interface Waiter {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Newline-delimited JSON-RPC 2.0 client side (docs/analyzer-cli.md, "Framing"): one JSON object per
 * line, no Content-Length headers. Transport-agnostic: feed it received chunks, give it a writer.
 */
export class JsonRpcConnection {
  private nextId = 1;
  private buffer = '';
  private closed: Error | undefined;
  private readonly waiters = new Map<number, Waiter>();
  private readonly notificationHandlers: NotificationHandler[] = [];

  constructor(
    private readonly write: (line: string) => void,
    private readonly onProtocolError: (message: string) => void = () => undefined,
  ) {}

  /** Feeds raw stdout data; complete lines are dispatched. */
  receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        this.dispatch(line);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  request<T>(method: string, params?: unknown): PendingRequest<T> {
    const id = this.nextId++;
    if (this.closed) {
      return { id, result: Promise.reject(this.closed) };
    }
    const result = new Promise<T>((resolve, reject) => {
      this.waiters.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
    });
    // Callers may ignore the promise (fire-and-forget requests); never leave a rejection unhandled.
    result.catch(() => undefined);
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      message.params = params;
    }
    this.send(message);
    return { id, result };
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }
    const message: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) {
      message.params = params;
    }
    this.send(message);
  }

  /** `$/cancelRequest`. The request still settles: with -32800, or with its result if it had finished. */
  cancel(id: number): void {
    if (this.waiters.has(id)) {
      this.notify('$/cancelRequest', { id });
    }
  }

  get pendingCount(): number {
    return this.waiters.size;
  }

  /** Rejects every pending request; later requests fail immediately. */
  close(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = error;
    for (const waiter of this.waiters.values()) {
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private send(message: Record<string, unknown>): void {
    // JSON.stringify never emits raw line breaks (they are escaped inside strings).
    this.write(JSON.stringify(message) + '\n');
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    } catch {
      this.onProtocolError(`not JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (message === null || typeof message !== 'object') {
      this.onProtocolError(`unexpected message: ${line.slice(0, 200)}`);
      return;
    }

    const hasId = 'id' in message && message.id !== null && message.id !== undefined;
    if (typeof message.method === 'string' && !hasId) {
      for (const handler of this.notificationHandlers) {
        handler(message.method, message.params);
      }
      return;
    }
    if (typeof message.method === 'string') {
      // The server never sends requests; answer politely so it does not wait.
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: RpcErrorCodes.methodNotFound, message: 'client handles no requests' } });
      return;
    }

    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const waiter = this.waiters.get(id);
    if (!waiter) {
      if (message.error && message.id === null) {
        this.onProtocolError(`server error without id: ${JSON.stringify(message.error)}`);
      }
      return;
    }
    this.waiters.delete(id);
    if ('error' in message && message.error) {
      const error = message.error as { code?: number; message?: string; data?: unknown };
      waiter.reject(new RpcError(error.code ?? RpcErrorCodes.internalError, `${waiter.method}: ${error.message ?? 'error'}`, error.data));
    } else {
      waiter.resolve(message.result);
    }
  }
}
