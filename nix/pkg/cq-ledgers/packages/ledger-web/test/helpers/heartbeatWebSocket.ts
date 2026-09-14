export class HeartbeatWebSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private pendingNonce: string | null = null;

  constructor(public url: string) {}

  send(data: string): void {
    const frame = JSON.parse(data) as { type: string; nonce: string };
    if (frame.type !== "ping" || typeof frame.nonce !== "string") {
      throw new Error("expected a nonce-bearing heartbeat ping");
    }
    this.pendingNonce = frame.nonce;
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  acknowledgeHeartbeat(): void {
    if (this.pendingNonce === null) throw new Error("no heartbeat ping to acknowledge");
    const nonce = this.pendingNonce;
    this.pendingNonce = null;
    this.push({ type: "pong", nonce });
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
