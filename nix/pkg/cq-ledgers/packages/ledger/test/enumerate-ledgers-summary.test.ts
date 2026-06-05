/**
 * Tests for the enumerate_ledgers handler's per-ledger statusCounts and
 * completedCount fields (T1).
 *
 * Seeds:
 *  - the questions ledger with items in `answered` and `open` statuses.
 *  - the tasks ledger (a terminal-bearing non-questions ledger) with items
 *    in `done` (terminal) and `planned` (non-terminal) statuses.
 *
 * Both ledgers are canonical and bootstrapped automatically; no seed required.
 *
 * Asserts:
 *  - statusCounts[status] equals the per-status active-item counts.
 *  - itemCount equals the total.
 *  - completedCount for the questions ledger counts ONLY `answered` items
 *    (NOT `withdrawn`, which is also terminal but does not represent a
 *    positive completion).
 *  - completedCount for the tasks ledger counts items in terminalStatuses
 *    (`done`), NOT non-terminal items (`planned`, `wip`).
 *  - Both fields are optional on LedgerSummary (compile-time check: fields
 *    may be undefined and callers must handle that gracefully).
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryLedgerStore,
  createLedgerMcpTools,
  QUESTIONS_LEDGER,
  TASKS_LEDGER,
  type LedgerSummary,
} from "../src/index.js";

/** Build a store with canonical ledgers bootstrapped (no seed needed). */
async function buildStore() {
  const store = new InMemoryLedgerStore({});
  await store.init();
  return store;
}

function callTool(
  tools: ReturnType<typeof createLedgerMcpTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool not found: ${name}`);
  return t.handler(args as never, null) as Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

function decode<T>(result: { content: Array<{ type: string; text: string }> }): T {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected single text content block");
  }
  return JSON.parse(first.text) as T;
}

describe("enumerate_ledgers — statusCounts and completedCount (T1)", () => {
  it("emits statusCounts and completedCount for each ledger in ledgerSummaries", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    // Create a milestone to anchor items under.
    await callTool(tools, "create_milestone", { title: "T1 seed milestone" });

    // questions: 2 answered + 1 open + 1 withdrawn
    await callTool(tools, "create_item", {
      ledger_id: QUESTIONS_LEDGER,
      milestone_id: "M1",
      status: "answered",
      fields: { question: "q1", answer: "a1" },
    });
    await callTool(tools, "create_item", {
      ledger_id: QUESTIONS_LEDGER,
      milestone_id: "M1",
      status: "answered",
      fields: { question: "q2", answer: "a2" },
    });
    await callTool(tools, "create_item", {
      ledger_id: QUESTIONS_LEDGER,
      milestone_id: "M1",
      status: "open",
      fields: { question: "q3" },
    });
    await callTool(tools, "create_item", {
      ledger_id: QUESTIONS_LEDGER,
      milestone_id: "M1",
      status: "withdrawn",
      fields: { question: "q4" },
    });

    // tasks: 1 done (terminal) + 1 planned (non-terminal)
    await callTool(tools, "create_item", {
      ledger_id: TASKS_LEDGER,
      milestone_id: "M1",
      status: "done",
      fields: { headline: "task done" },
    });
    await callTool(tools, "create_item", {
      ledger_id: TASKS_LEDGER,
      milestone_id: "M1",
      status: "planned",
      fields: { headline: "task planned" },
    });

    const result = decode<{
      ledgers: string[];
      counts: Record<string, number>;
      ledgerSummaries: LedgerSummary[];
    }>(await callTool(tools, "enumerate_ledgers", {}));

    // Sanity: ledgerSummaries must be present.
    expect(Array.isArray(result.ledgerSummaries)).toBe(true);

    // Helper: find summary by name.
    const find = (name: string) => result.ledgerSummaries.find((s) => s.name === name);

    // ---- questions ledger ----
    const qs = find(QUESTIONS_LEDGER);
    expect(qs).toBeDefined();

    // itemCount = 4 total active items
    expect(qs!.itemCount).toBe(4);

    // statusCounts must match the exact per-status distribution
    expect(qs!.statusCounts).toBeDefined();
    expect(qs!.statusCounts!["answered"]).toBe(2);
    expect(qs!.statusCounts!["open"]).toBe(1);
    expect(qs!.statusCounts!["withdrawn"]).toBe(1);

    // completedCount for questions = answered ONLY (NOT withdrawn, which is
    // also terminal but does not represent a positive completion).
    expect(qs!.completedCount).toBe(2);

    // ---- tasks ledger ----
    const ts = find(TASKS_LEDGER);
    expect(ts).toBeDefined();

    // itemCount = 2 total active items
    expect(ts!.itemCount).toBe(2);

    // statusCounts must match
    expect(ts!.statusCounts).toBeDefined();
    expect(ts!.statusCounts!["done"]).toBe(1);
    expect(ts!.statusCounts!["planned"]).toBe(1);

    // completedCount for tasks = items in terminalStatuses (done, abandoned)
    // Only "done" is present here.
    expect(ts!.completedCount).toBe(1);
  });

  it("completedCount uses terminalStatuses for non-questions ledgers (multiple terminal statuses)", async () => {
    const store = await buildStore();
    const tools = createLedgerMcpTools(store);

    await callTool(tools, "create_milestone", { title: "multi-terminal" });

    // tasks: done=2, wip=1, planned=1 — done and abandoned are terminal in TASKS_SCHEMA
    await callTool(tools, "create_item", {
      ledger_id: TASKS_LEDGER,
      milestone_id: "M1",
      status: "done",
      fields: { headline: "t1" },
    });
    await callTool(tools, "create_item", {
      ledger_id: TASKS_LEDGER,
      milestone_id: "M1",
      status: "done",
      fields: { headline: "t2" },
    });
    await callTool(tools, "create_item", {
      ledger_id: TASKS_LEDGER,
      milestone_id: "M1",
      status: "wip",
      fields: { headline: "t3" },
    });
    await callTool(tools, "create_item", {
      ledger_id: TASKS_LEDGER,
      milestone_id: "M1",
      status: "planned",
      fields: { headline: "t4" },
    });

    const result = decode<{ ledgerSummaries: LedgerSummary[] }>(
      await callTool(tools, "enumerate_ledgers", {}),
    );
    const ts = result.ledgerSummaries.find((s) => s.name === TASKS_LEDGER);
    expect(ts).toBeDefined();
    expect(ts!.itemCount).toBe(4);
    expect(ts!.completedCount).toBe(2); // only the 2 "done" items
  });

  it("statusCounts and completedCount are optional on LedgerSummary (type safety)", () => {
    // Compile-time test: a minimal LedgerSummary without the optional fields
    // must still satisfy the type. This catches any accidental change that makes
    // the fields required.
    const minimal: LedgerSummary = { name: "x", itemCount: 0 };
    expect(minimal.statusCounts).toBeUndefined();
    expect(minimal.completedCount).toBeUndefined();

    // A full summary with both fields must also type-check.
    const full: LedgerSummary = {
      name: "y",
      itemCount: 5,
      statusCounts: { open: 3, done: 2 },
      completedCount: 2,
    };
    expect(full.statusCounts?.["done"]).toBe(2);
    expect(full.completedCount).toBe(2);
  });
});
