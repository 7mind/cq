/**
 * goals-tab.test.ts — Goals tab (cycle 4) unit tests.
 *
 * Cases:
 *  1. Renders a seeded snapshot: goal → milestones → open questions; answered
 *     questions hidden behind a "show N answered" toggle; tasks shown as chips.
 *  2. Badge: onBadgeChange receives totalOpenQuestions; the App badge hides at 0
 *     (covered by App via openQuestions>0 guard — here we assert the reported
 *     value transitions 1 → 0 on a fresh snapshot).
 *  3. Question card: clicking a suggestion chip pre-fills the textarea; submit
 *     emits question.answer with the trimmed free-form text.
 *  4. Escalation card: emits workflow.escalation_reply for proceed / abandon /
 *     guidance (guidance includes the typed text).
 */

// Must be first — registers DOM globals.
import { registerDom } from "./helpers/dom";
registerDom();

import { describe, test, expect, afterEach } from "bun:test";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";

import type { ManagerStats } from "../src/ws/Manager";
import type { ServerFrame, ClientFrame, GoalsSnapshot, WorkflowEvent } from "@cq/shared";
import { ConnectionProvider } from "../src/ws/ConnectionProvider";
import { GoalsTab } from "../src/goals/GoalsTab";

type UpdateCb = (stats: ManagerStats) => void;
type MessageCb = (frame: ServerFrame) => void;

function makeStats(): ManagerStats {
  return {
    connections: [
      { id: "conn-1", state: "ALIVE", rtt: 10, uptimeMs: 1000, oldestPendingPingSentAt: null, enteredStaleAt: null, connectedAt: null },
    ],
    activeConnectionId: "conn-1",
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
  };
}

class FakeManager {
  private readonly _msgSubs: MessageCb[] = [];
  readonly sent: ClientFrame[] = [];
  private _stats: ManagerStats = makeStats();
  get stats(): ManagerStats { return this._stats; }
  onUpdate(_cb: UpdateCb): () => void { return () => {}; }
  onMessage(cb: MessageCb): () => void {
    this._msgSubs.push(cb);
    return () => {
      const i = this._msgSubs.indexOf(cb);
      if (i !== -1) this._msgSubs.splice(i, 1);
    };
  }
  send(frame: ClientFrame): boolean { this.sent.push(frame); return true; }
  injectMessage(frame: ServerFrame): void {
    act(() => { for (const cb of this._msgSubs) cb(frame); });
  }
}

function snapshot(overrides: Partial<GoalsSnapshot> = {}): GoalsSnapshot {
  return {
    type: "goals.snapshot",
    seq: 1,
    ts: Date.now(),
    requestSeq: 1,
    totalOpenQuestions: 1,
    goals: [
      {
        id: "G1",
        title: "Notes app",
        description: "A notes app.",
        status: "clarifying",
        openQuestionCount: 1,
        milestones: [
          {
            id: "M1",
            title: "produce an actionable specification",
            status: "open",
            questions: [
              {
                id: "Q1",
                question: "Which platforms?",
                context: "scope detail",
                suggestions: ["web", "desktop"],
                recommendation: "web",
                status: "open",
              },
              {
                id: "Q2",
                question: "Already answered?",
                suggestions: [],
                status: "answered",
                answer: "yes earlier",
              },
            ],
            tasks: [],
          },
          {
            id: "M2",
            title: "Core build",
            status: "open",
            questions: [],
            tasks: [{ id: "T1", headline: "Editor", status: "planned" }],
          },
        ],
      },
    ],
    ...overrides,
  } as GoalsSnapshot;
}

let container: HTMLDivElement | null = null;
let reactRoot: ReturnType<typeof createRoot> | null = null;
const badgeValues: number[] = [];

function setup(): void {
  badgeValues.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  reactRoot = createRoot(container);
}
function teardown(): void {
  if (reactRoot) { act(() => { reactRoot!.unmount(); }); reactRoot = null; }
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = null;
}
afterEach(teardown);

function render(manager: FakeManager): void {
  act(() => {
    reactRoot!.render(
      createElement(
        ConnectionProvider,
        { value: manager as never },
        createElement(GoalsTab, { onBadgeChange: (n: number) => { badgeValues.push(n); } }),
      ),
    );
  });
}

function q(testid: string): HTMLElement {
  return container!.querySelector(`[data-testid='${testid}']`) as HTMLElement;
}

/** Set a controlled <textarea>/<input> value via its React onChange (happy-dom quirk). */
function setText(el: HTMLElement, value: string): void {
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (propsKey === undefined) throw new Error("no React props on element");
  const props = (el as unknown as Record<string, { onChange?: (e: unknown) => void }>)[propsKey];
  if (typeof props.onChange !== "function") throw new Error("element has no onChange");
  act(() => {
    (el as HTMLTextAreaElement).value = value;
    props.onChange!({ target: el, currentTarget: el });
  });
}

describe("GoalsTab", () => {
  test("(1) mount sends goals.list; renders goal/milestones/open questions; answered hidden behind toggle; tasks shown", () => {
    setup();
    const m = new FakeManager();
    render(m);

    // On mount (ALIVE) the tab requests goals.list.
    expect(m.sent.some((f) => f.type === "goals.list")).toBe(true);

    m.injectMessage(snapshot());

    // Goal row + status chip.
    expect(q("goal-G1")).not.toBeNull();
    expect(q("goal-status-G1").textContent).toBe("clarifying");

    // Row header shows the SHORT title; the expanded body shows the detailed
    // description (the goal auto-expands because it has an open question).
    expect(q("goal-title-G1").textContent).toBe("Notes app");
    expect(q("goal-description-G1").textContent).toBe("A notes app.");

    // Open question rendered; answered one hidden until the toggle.
    expect(q("goal-question-Q1")).not.toBeNull();
    expect(q("goal-question-Q2")).toBeNull();
    const toggle = q("goal-answered-toggle-M1") as HTMLButtonElement;
    expect(toggle.textContent).toContain("show 1 answered");
    act(() => { toggle.click(); });
    expect(q("goal-question-Q2")).not.toBeNull();
    expect(q("goal-question-answer-Q2").textContent).toBe("yes earlier");

    // Tasks shown under the planner milestone.
    expect(q("goal-task-T1").textContent).toContain("Editor");

    // Badge value reported.
    expect(badgeValues.at(-1)).toBe(1);
  });

  test("(2) badge value transitions 1 → 0 on a fresh snapshot", () => {
    setup();
    const m = new FakeManager();
    render(m);
    m.injectMessage(snapshot());
    expect(badgeValues.at(-1)).toBe(1);
    m.injectMessage(snapshot({ totalOpenQuestions: 0 }));
    expect(badgeValues.at(-1)).toBe(0);
  });

  test("(3) suggestion chip pre-fills the textarea; submit emits question.answer with trimmed text", () => {
    setup();
    const m = new FakeManager();
    render(m);
    m.injectMessage(snapshot());

    const chip = q("goal-suggestion-Q1-0") as HTMLButtonElement; // "web"
    expect(chip.textContent).toContain("web");
    // The recommended chip carries the marker.
    expect(chip.textContent).toContain("recommended");

    const input = q("goal-answer-input-Q1") as HTMLTextAreaElement;
    const submit = q("goal-answer-submit-Q1") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Clicking the chip pre-fills (does NOT auto-submit).
    act(() => { chip.click(); });
    expect(input.value).toBe("web");
    expect(m.sent.some((f) => f.type === "question.answer")).toBe(false);
    expect(submit.disabled).toBe(false);

    // Edit with surrounding whitespace → submit trims.
    setText(input, "  web app  ");
    act(() => { submit.click(); });
    const answer = m.sent.find((f) => f.type === "question.answer") as Extract<ClientFrame, { type: "question.answer" }>;
    expect(answer).toBeDefined();
    expect(answer.questionId).toBe("Q1");
    expect(answer.answer).toBe("web app");
  });

  test("(4) escalation card emits workflow.escalation_reply for proceed / abandon / guidance", () => {
    // proceed
    setup();
    let m = new FakeManager();
    render(m);
    m.injectMessage(snapshot());
    const escEvent: WorkflowEvent = {
      type: "workflow.event", seq: 2, ts: Date.now(), workflowId: crypto.randomUUID(),
      goalId: "G1", phase: "review", status: "escalated", detail: "no progress",
    };
    m.injectMessage(escEvent);
    expect(q("goal-escalation-G1")).not.toBeNull();
    act(() => { (q("goal-escalation-proceed-G1") as HTMLButtonElement).click(); });
    let reply = m.sent.find((f) => f.type === "workflow.escalation_reply") as Extract<ClientFrame, { type: "workflow.escalation_reply" }>;
    expect(reply.goalId).toBe("G1");
    expect(reply.choice).toBe("proceed");
    teardown();

    // abandon
    setup();
    m = new FakeManager();
    render(m);
    m.injectMessage(snapshot());
    m.injectMessage(escEvent);
    act(() => { (q("goal-escalation-abandon-G1") as HTMLButtonElement).click(); });
    reply = m.sent.find((f) => f.type === "workflow.escalation_reply") as Extract<ClientFrame, { type: "workflow.escalation_reply" }>;
    expect(reply.choice).toBe("abandon");
    teardown();

    // guidance — opens textarea; includes the typed text.
    setup();
    m = new FakeManager();
    render(m);
    m.injectMessage(snapshot());
    m.injectMessage(escEvent);
    act(() => { (q("goal-escalation-guidance-G1") as HTMLButtonElement).click(); });
    const gInput = q("goal-escalation-guidance-input-G1") as HTMLTextAreaElement;
    const gSubmit = q("goal-escalation-guidance-submit-G1") as HTMLButtonElement;
    expect(gSubmit.disabled).toBe(true);
    setText(gInput, "  use SQLite  ");
    expect(gSubmit.disabled).toBe(false);
    act(() => { gSubmit.click(); });
    reply = m.sent.find((f) => f.type === "workflow.escalation_reply") as Extract<ClientFrame, { type: "workflow.escalation_reply" }>;
    expect(reply.choice).toBe("guidance");
    expect(reply.guidance).toBe("use SQLite");
  });
});
