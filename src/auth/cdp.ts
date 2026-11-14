/** Minimal Chrome DevTools Protocol client over the global WebSocket (Node >= 22) */

export interface CdpEvent {
  method: string;
  params: {
    headers?: Record<string, string>;
    request?: { headers?: Record<string, string> };
  };
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
  method?: string;
  params?: CdpEvent["params"];
}

const MAX_EVENTS = 1000;

export class CdpClient {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly events: CdpEvent[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) =>
      this.onMessage(String(event.data)),
    );
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const client = new CdpClient(socket);
      socket.addEventListener("open", () => resolve(client), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Could not connect to Chrome DevTools")),
        { once: true },
      );
    });
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  /** Network events captured since the client attached (bounded ring) */
  recentEvents(): readonly CdpEvent[] {
    return this.events;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }

  private onMessage(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error)
        waiter?.reject(new Error(JSON.stringify(message.error)));
      else waiter?.resolve(message.result);
    } else if (message.method) {
      this.events.push({
        method: message.method,
        params: message.params ?? {},
      });
      if (this.events.length > MAX_EVENTS) this.events.shift();
    }
  }
}
