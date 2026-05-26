/**
 * MockWebSocket — minimal in-memory WebSocket stub for testing Connection.
 *
 * Satisfies the `SocketLike` structural interface that Connection uses:
 *   - readyState (0=CONNECTING, 1=OPEN, 3=CLOSED)
 *   - send(data): records outbound frames to `sent[]`
 *   - close(code, reason): records call to `closed[]`; fires synthetic close event
 *   - addEventListener / removeEventListener: four event types
 *
 * Test control methods:
 *   - simulateOpen(): fires the "open" event; sets readyState=1
 *   - simulateMessage(data): fires a MessageEvent with .data = data
 *   - simulateClose(code, reason): fires a CloseEvent; sets readyState=3
 */

import type { SocketLike } from "../../src/ws/Connection";

export interface CloseRecord {
  code: number;
  reason: string;
}

type EventHandler = (event: Event | MessageEvent | CloseEvent) => void;

export class MockWebSocket implements SocketLike {
  // WebSocket readyState constants
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Outbound frames recorded by send(). */
  readonly sent: string[] = [];
  /** All close() calls recorded. */
  readonly closed: CloseRecord[] = [];

  private _readyState: number = MockWebSocket.CONNECTING;
  private readonly _handlers: Map<string, Set<EventHandler>> = new Map();

  get readyState(): number {
    return this._readyState;
  }

  send(data: string): void {
    if (this._readyState !== MockWebSocket.OPEN) {
      throw new Error(`MockWebSocket.send called when readyState=${this._readyState}`);
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this._readyState === MockWebSocket.CLOSED) return;
    const c = code ?? 1000;
    const r = reason ?? "";
    this.closed.push({ code: c, reason: r });
    this._readyState = MockWebSocket.CLOSED;
    // Simulate the close event firing (synchronous in tests)
    this._fire("close", this._makeCloseEvent(c, r));
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: EventHandler,
  ): void {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, new Set());
    }
    this._handlers.get(type)!.add(listener);
  }

  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: EventHandler,
  ): void {
    this._handlers.get(type)?.delete(listener);
  }

  // ---------------------------------------------------------------------------
  // Test control methods
  // ---------------------------------------------------------------------------

  /** Simulate the WebSocket opening. Sets readyState=OPEN, fires "open". */
  simulateOpen(): void {
    this._readyState = MockWebSocket.OPEN;
    this._fire("open", new Event("open"));
  }

  /** Simulate an inbound message. Fires a synthetic MessageEvent. */
  simulateMessage(data: string): void {
    const evt = this._makeMessageEvent(data);
    this._fire("message", evt);
  }

  /**
   * Simulate the server closing the connection (or an abnormal close).
   * Sets readyState=CLOSED, fires "close". Does NOT record to `closed[]`
   * (that array tracks only calls from Connection.close(), not from the server).
   */
  simulateClose(code: number, reason: string = ""): void {
    if (this._readyState === MockWebSocket.CLOSED) return;
    this._readyState = MockWebSocket.CLOSED;
    this._fire("close", this._makeCloseEvent(code, reason));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _fire(type: string, event: Event | MessageEvent | CloseEvent): void {
    const handlers = this._handlers.get(type);
    if (!handlers) return;
    for (const h of handlers) {
      h(event);
    }
  }

  private _makeMessageEvent(data: string): MessageEvent {
    // MessageEvent constructor is available in both browser and Bun environments.
    return new MessageEvent("message", { data });
  }

  private _makeCloseEvent(code: number, reason: string): CloseEvent {
    // CloseEvent init-dict support is absent in happy-dom (fields stay undefined).
    // Assign the properties manually so the event works under both Bun native and
    // happy-dom environments.
    const evt = new CloseEvent("close");
    Object.defineProperty(evt, "code", { value: code });
    Object.defineProperty(evt, "reason", { value: reason });
    Object.defineProperty(evt, "wasClean", { value: code === 1000 });
    return evt;
  }
}
