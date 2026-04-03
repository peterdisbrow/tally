import { getRelayUrl, getAuthToken } from '../api/client';
import type { ServerMessage } from './types';
import { Sentry } from '../lib/sentry';

type MessageHandler = (msg: ServerMessage) => void;
type ConnectionHandler = (connected: boolean) => void;

const PING_INTERVAL_MS = 25000;
const PONG_TIMEOUT_MS = 35000;

export class TallySocket {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 30000;
  private intentionallyClosed = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;

  async connect(): Promise<void> {
    // Guard: skip if already connected or connecting
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.intentionallyClosed = false;
    this.backoffMs = 1000;

    try {
      const baseUrl = await getRelayUrl();
      const token = await getAuthToken();
      if (!token) return;

      // Convert HTTP URL to WebSocket URL
      const wsUrl = baseUrl.replace(/^http/, 'ws');

      this.ws = new WebSocket(`${wsUrl}/mobile`, [`token.${token}`]);

      this.ws.onopen = () => {
        this.backoffMs = 1000;
        // Treat the connection open itself as an implicit pong so the first
        // staleness check doesn't fire before the server has had a chance to respond.
        this.lastPongAt = Date.now();
        this.notifyConnection(true);
        this.startPing();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          // Intercept pong internally — not an app-level message
          if ((msg as { type: string }).type === 'pong') {
            this.lastPongAt = Date.now();
            return;
          }
          this.notifyMessage(msg);
        } catch (e) {
          // Malformed JSON — ignore, but track if it's frequent
          Sentry.captureException(e, { extra: { raw: event.data } });
        }
      };

      this.ws.onclose = () => {
        this.cleanup();
        this.notifyConnection(false);
        if (!this.intentionallyClosed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        // Error will trigger close, which handles reconnection
      };
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'WebSocket connect' } });
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onConnection(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      // If the server hasn't responded within PONG_TIMEOUT_MS, the TCP
      // connection is stale. Close it so onclose triggers a reconnect.
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        this.ws?.close(4000, 'pong timeout');
        return;
      }
      this.send({ type: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  private notifyMessage(msg: ServerMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(msg);
      } catch (e) {
        // Don't let one handler crash others
        Sentry.captureException(e, { extra: { context: 'WebSocket message handler', msgType: (msg as { type?: string }).type } });
      }
    }
  }

  private notifyConnection(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected);
      } catch (e) {
        // Don't let one handler crash others
        Sentry.captureException(e, { extra: { context: 'WebSocket connection handler', connected } });
      }
    }
  }
}

// Singleton instance
export const tallySocket = new TallySocket();
