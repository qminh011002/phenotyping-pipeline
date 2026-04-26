// WebSocket client for real-time log streaming from the backend.
//
// The backend pushes messages over /logs/stream:
//   { type: "log", data: LogEntry }
//   { type: "heartbeat", data: null }
//
// The server also pushes a heartbeat every 1 second so the client can detect
// dropped connections. On disconnect, this client automatically reconnects
// with exponential backoff.

import type { LogEntry, LogStreamMessage } from "@/types/api";

/** Callbacks for log stream events. */
export interface LogStreamCallbacks {
  onLog: (entry: LogEntry) => void;
  onHeartbeat: () => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (err: Error) => void;
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000;   // 1 second initial delay
const MAX_RECONNECT_DELAY_MS = 30_000;       // cap at 30 seconds
const RECONNECT_BACKOFF_MULTIPLIER = 2;

export class LogStreamClient {
  private _ws: WebSocket | null = null;
  private _callbacks: LogStreamCallbacks;
  private _reconnectDelay = DEFAULT_RECONNECT_DELAY_MS;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _shouldReconnect = false;
  private _closed = false;

  constructor(callbacks: LogStreamCallbacks) {
    this._callbacks = callbacks;
  }

  /** Connect to the log stream WebSocket and begin receiving events. */
  connect(baseUrl: string): void {
    this._closed = false;
    this._shouldReconnect = true;
    this._doConnect(baseUrl);
  }

  /** Immediately disconnect and stop auto-reconnecting. */
  disconnect(): void {
    this._shouldReconnect = false;
    this._cancelReconnect();
    this._closeWebSocket("User requested disconnect");
  }

  private _doConnect(baseUrl: string): void {
    this._cancelReconnect();

    const wsUrl = baseUrl
      .replace(/^http:\/\//, "ws://")
      .replace(/^https:\/\//, "wss://")
      .replace(/\/$/, "") + "/logs/stream";

    try {
      this._ws = new WebSocket(wsUrl);
    } catch (err) {
      this._callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      this._scheduleReconnect(baseUrl);
      return;
    }

    this._ws.onopen = () => {
      this._reconnectDelay = DEFAULT_RECONNECT_DELAY_MS;
      this._callbacks.onConnect?.();
    };

    this._ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as LogStreamMessage;
        if (msg.type === "log" && msg.data !== null) {
          this._callbacks.onLog(msg.data);
        } else if (msg.type === "heartbeat") {
          this._callbacks.onHeartbeat();
        }
      } catch (err) {
        this._callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    this._ws.onerror = () => {
      this._callbacks.onError?.(new Error("WebSocket error"));
    };

    this._ws.onclose = (event: CloseEvent) => {
      const reason = event.reason || `WebSocket closed (code ${event.code})`;
      this._callbacks.onDisconnect?.(reason);

      if (this._shouldReconnect && !this._closed) {
        this._scheduleReconnect(baseUrl);
      }
    };
  }

  private _scheduleReconnect(baseUrl: string): void {
    this._cancelReconnect();
    this._reconnectTimer = setTimeout(() => {
      if (this._shouldReconnect && !this._closed) {
        this._doConnect(baseUrl);
      }
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * RECONNECT_BACKOFF_MULTIPLIER, MAX_RECONNECT_DELAY_MS);
  }

  private _cancelReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _closeWebSocket(reason: string): void {
    if (this._ws !== null) {
      this._ws.onopen = null;
      this._ws.onmessage = null;
      this._ws.onerror = null;
      this._ws.onclose = null;
      this._ws.close(1000, reason);
      this._ws = null;
    }
    this._closed = true;
  }
}
