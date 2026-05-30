/**
 * plan-echo.test.ts — PLAN-D04.
 *
 * Typing `/plan <text>` routes to a workflow.start frame; the server never
 * echoes it as a chat.event, so without a client-side echo the user's typed
 * line vanished from the transcript. This asserts:
 *   (1) the typed `/plan …` line renders as a user bubble in the chat stream;
 *   (2) a workflow.start frame is still emitted carrying the goal text.
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { act } from "react";

import type { ManagerStats } from "../src/ws/Manager";
import type { ServerFrame, ClientFrame, WorkflowStart } from "@cq/shared";
import { ConnectionProvider } from "../src/ws/ConnectionProvider";
import { ChatTab } from "../src/chat/ChatTab";
import { SessionProvider } from "../src/chat/SessionContext";

// --- Minimal FakeManager (mirrors chat-autostart.test.ts) ------------------

type UpdateCb = (stats: ManagerStats) => void;

function makeStats(overrides: Partial<ManagerStats> = {}): ManagerStats {
  return {
    connections: [],
    activeConnectionId: null,
    attempt: 0,
    maxAttempts: 15,
    isTerminal: false,
    lastCloseCode: null,
    lastCloseReason: "",
    nextRetryAt: null,
    retryScheduledAt: null,
    pendingReconnectOnVisible: false,
    rttWindows: { "30s": null, "1m": null, "5m": null },
    lossPct: 0,
    events: [],
    ...overrides,
  };
}

const ALIVE_STATS = makeStats({
  connections: [
    {
      id: "c1",
      state: "ALIVE",
      rtt: null,
      uptimeMs: 0,
      oldestPendingPingSentAt: null,
      enteredStaleAt: null,
      connectedAt: null,
    },
  ],
  activeConnectionId: "c1",
});

class FakeManager {
  private _stats: ManagerStats;
  private readonly _updateSubs: UpdateCb[] = [];
  private readonly _msgSubs: Array<(f: ServerFrame) => void> = [];
  readonly sent: ClientFrame[] = [];

  constructor(initialStats: ManagerStats) {
    this._stats = initialStats;
  }
  get stats(): ManagerStats { return this._stats; }
  onUpdate(cb: UpdateCb): () => void { this._updateSubs.push(cb); return () => {}; }
  onMessage(cb: (f: ServerFrame) => void): () => void { this._msgSubs.push(cb); return () => {}; }
  send(frame: ClientFrame): boolean { this.sent.push(frame); return true; }
  emit(frame: ServerFrame): void { for (const cb of this._msgSubs) cb(frame); }
}

// --- DOM lifecycle ---------------------------------------------------------

let container: HTMLDivElement | null = null;
let reactRoot: ReturnType<typeof createRoot> | null = null;

function setup(): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  return container;
}

function teardown(): void {
  if (reactRoot) { act(() => { reactRoot!.unmount(); }); reactRoot = null; }
  if (container && container.parentNode) container.parentNode.removeChild(container);
  container = null;
  try { localStorage.removeItem("cq.activeSessionId"); } catch { /* ignore */ }
}

afterEach(() => { teardown(); });

/**
 * Type into the (uncontrolled) textarea and submit with a bare Enter.
 * The textarea must be focused before dispatching keydown to avoid a
 * React 19 + happy-dom crash (see input.test.ts header).
 */
function submitLine(c: HTMLDivElement, text: string): void {
  const ta = c.querySelector("textarea") as HTMLTextAreaElement | null;
  if (ta === null) throw new Error("textarea not found");
  ta.value = text;
  ta.focus();
  const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  act(() => { ta.dispatchEvent(e); });
}

describe("PLAN-D04 — /plan line is preserved in the chat transcript", () => {
  test("typing /plan <text> renders the line AND emits workflow.start", () => {
    const manager = new FakeManager(ALIVE_STATS);
    const c = setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(SessionProvider, null,
            createElement(ChatTab),
          ),
        ),
      );
    });

    submitLine(c, "/plan add a dark theme toggle");

    // (1) The typed line renders as a user bubble in the stream.
    const userBubbles = c.querySelectorAll('[data-testid^="stream-user-"]');
    expect(userBubbles.length).toBe(1);
    expect(userBubbles[0]!.textContent ?? "").toContain("/plan add a dark theme toggle");

    // (2) A workflow.start frame was emitted carrying the stripped goal text.
    const starts = manager.sent.filter((f) => f.type === "workflow.start") as WorkflowStart[];
    expect(starts).toHaveLength(1);
    expect(starts[0]!.kind).toBe("plan");
    expect(starts[0]!.text).toBe("add a dark theme toggle");
    expect(starts[0]!.goalRef).toBeUndefined();

    // No chat.input frame is sent for a /plan line (it routes to the workflow lane).
    expect(manager.sent.filter((f) => f.type === "chat.input")).toHaveLength(0);
  });

  test("a /plan G<id> continuation line also renders and carries goalRef", () => {
    const manager = new FakeManager(ALIVE_STATS);
    const c = setup();

    act(() => {
      reactRoot!.render(
        createElement(ConnectionProvider, { value: manager as never },
          createElement(SessionProvider, null,
            createElement(ChatTab),
          ),
        ),
      );
    });

    submitLine(c, "/plan G3 add export to CSV");

    const userBubbles = c.querySelectorAll('[data-testid^="stream-user-"]');
    expect(userBubbles.length).toBe(1);
    expect(userBubbles[0]!.textContent ?? "").toContain("/plan G3 add export to CSV");

    const starts = manager.sent.filter((f) => f.type === "workflow.start") as WorkflowStart[];
    expect(starts).toHaveLength(1);
    expect(starts[0]!.goalRef).toBe("G3");
    expect(starts[0]!.text).toBe("add export to CSV");
  });
});
