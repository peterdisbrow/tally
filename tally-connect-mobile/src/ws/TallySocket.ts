import { getRelayUrl, getAuthToken } from '../api/client';
import type { ServerMessage } from './types';

type MessageHandler = (msg: ServerMessage) => void;
type ConnectionHandler = (connected: boolean) => void;

export class TallySocket {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 30000;
  private intentionallyClosed = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.backoffMs = 1000;

    try {
      const baseUrl = await getRelayUrl();
      const token = await getAuthToken();
      if (!token) return;

      // Convert HTTP URL to WebSocket URL
      const wsUrl = baseUrl.replace(/^http/, 'ws');

      this.ws = new WebSocket(`${wsUrl}/mobile?token=${encodeURIComponent(token)}`);

      this.ws.onopen = () => {
        this.backoffMs = 1000;
        this.notifyConnection(true);
        this.startPing();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          this.notifyMessage(msg);
        } catch {
          // Malformed JSON — ignore
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
    } catch {
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
      this.send({ type: 'ping', ts: Date.now() });
    }, 25000);
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
      } catch {
        // Don't let one handler crash others
      }
    }
  }

  private notifyConnection(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected);
      } catch {
        // Don't let one handler crash others
      }
    }
  }
}

// Singleton instance
export const tallySocket = new TallySocket();
