/**
 * workflow-codex-relay-integration.test.ts (codexwf) — the Codex /plan loop
 * driven on platform="codex" through the REAL relay seam against a FAKE codex
 * thread + a fake channel (no codex CLI, no cq-mcp child spawn).
 *
 * The fake replaces ONLY the codex-thread + cq-mcp-child middle: the
 * WorkflowSubmitProxy (correlation + per-phase Zod validation + ack), the
 * WorkflowRuntime (HARNESS ledger writes), and the loop logic are all REAL.
 * Mirrors the Claude `workflow-loops-integration` test but on the Codex path.
 *
 *   1. producer (produce)            → goal + 1 question, status clarifying
 *   2. answer the question           → clarify-reviewer runs
 *   3. clarify-reviewer (clear)      → planner runs
 *   4. planner                       → milestones + tasks, status planning
 *   5. plan-reviewer (satisfied)     → status planned + done
 *
 * Adversarial invariant under test: the HARNESS writes every ledger (the fake
 * relay NEVER writes a ledger — it only calls proxy.onSubmit); per-phase
 * validation gates each write; the goal converges to planned.
 */

import { describe, it, expect } from "bun:test";
import { InMemoryLedgerStore, GOALS_LEDGER, QUESTIONS_LEDGER, TASKS_LEDGER } from "@cq/ledger";
import {
  WorkflowRuntime,
  WorkflowSubmitProxy,
  CodexProducer,
  CodexPhaseSubagent,
  INCREMENT_MILESTONE_PREFIX,
  SPEC_MILESTONE_TITLE,
  makeSubmitIdGenerator,
} from "../src/workflow/index";
import type { WorkflowEvent } from "@cq/shared";
import { noopLogger } from "./helpers/mockBridge";
import { makeFakeCodexFactory } from "./helpers/fakeCodexRelay";

describe("workflow Codex relay — full loop on platform=codex (fake codex + real proxy)", () => {
  it("drives produce→clarify→plan→review→planned end-to-end via the relay", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();

    const acks: Array<{ submitId: string; ok: boolean; error?: string }> = [];
    const submitProxy = new WorkflowSubmitProxy({
      logger: noopLogger,
      sendAck: (submitId, ok, error) => acks.push({ submitId, ok, ...(error !== undefined ? { error } : {}) }),
    });

    // Track every ledger write to prove the HARNESS (not the relay) writes.
    const writes: string[] = [];
    const origCreateItem = store.createItem.bind(store);
    store.createItem = (async (ledgerId: string, milestoneId: string, init: never) => {
      writes.push(`createItem:${ledgerId}`);
      return origCreateItem(ledgerId, milestoneId, init);
    }) as typeof store.createItem;

    // Canned payloads per phase; the fake codex thread relays them to the proxy.
    const codexFactory = makeFakeCodexFactory({
      relay: (submitId, phase, payload) => submitProxy.onSubmit({ submitId, phase, payload }),
      payloads: {
        produce: {
          goal: { description: "A notes app." },
          questions: [{ question: "Which platforms?", recommendation: "web" }],
        },
        clarify_review: { clear: true, contradictions: [], newQuestions: [] },
        plan: {
          milestones: [{ title: "Core", description: "the core build" }],
          tasks: [{ milestoneRef: 0, headline: "Editor", description: "editor", acceptance: "renders" }],
        },
        plan_review: { satisfied: true, findings: [], newQuestions: [] },
      },
    });

    const codexDeps = {
      logger: noopLogger,
      cwd: "/tmp/codex-relay-test",
      submitProxy,
      internalWsUrl: "ws://127.0.0.1:1/__internal/cq-mcp",
      internalWsToken: "tok",
      nextSubmitId: makeSubmitIdGenerator(4242),
      codexFactory,
      timeoutMs: 10_000,
    };

    const rt = new WorkflowRuntime({
      logger: noopLogger,
      store,
      selectProducer: () => new CodexProducer(codexDeps),
      selectPhaseSubagent: () => new CodexPhaseSubagent(codexDeps),
    });
    const events: Array<Omit<WorkflowEvent, "seq" | "ts">> = [];
    rt.subscribe((e) => events.push(e));

    const res = await rt.startPlan({ text: "build a notes app", platform: "codex" }, (e) => events.push(e));
    expect(res.outcome).toBe("questions_ready");
    if (res.outcome !== "questions_ready") throw new Error("unreachable");
    const goalId = res.goalId;

    // Goal landed in clarifying with the spec milestone + 1 question.
    const goalAfterProduce = store.fetchItem(GOALS_LEDGER, goalId);
    expect(goalAfterProduce.status).toBe("clarifying");
    const specId = (goalAfterProduce.fields["milestones"] as string[])[0]!;
    const q0 = (store.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [])[0]!;
    expect(q0.fields["question"]).toBe("Which platforms?");

    // Answer the question → drives the rest of the loop synchronously through
    // the fake relay (each phase resolves in-process).
    await rt.submitAnswer(q0.id, "web");

    // Let the chained dispatches settle (advanceGoal is fire-and-forget).
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (store.fetchItem(GOALS_LEDGER, goalId).status === "planned") break;
      await Bun.sleep(10);
    }

    const goal = store.fetchItem(GOALS_LEDGER, goalId);
    expect(goal.status).toBe("planned");
    const ms = goal.fields["milestones"] as string[];
    expect(ms.length).toBe(2); // spec + planner milestone
    const tasks = store.listMilestoneItems(ms[1]!)[TASKS_LEDGER] ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.fields["headline"]).toBe("Editor");
    expect(events.map((e) => e.status)).toContain("done");

    // Every submit was acked ok (producer + clarify + plan + review).
    expect(acks.length).toBeGreaterThanOrEqual(4);
    expect(acks.every((a) => a.ok)).toBe(true);

    // The HARNESS wrote the ledgers (goal, questions, tasks all via store).
    expect(writes).toContain(`createItem:${GOALS_LEDGER}`);
    expect(writes).toContain(`createItem:${QUESTIONS_LEDGER}`);
    expect(writes).toContain(`createItem:${TASKS_LEDGER}`);

    await store.dispose();
  }, 20_000);

  it("a malformed Codex payload is acked {ok:false} and writes NO ledger (per-phase validation)", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();

    const acks: Array<{ ok: boolean; error?: string }> = [];
    const submitProxy = new WorkflowSubmitProxy({
      logger: noopLogger,
      sendAck: (_submitId, ok, error) => acks.push({ ok, ...(error !== undefined ? { error } : {}) }),
    });

    // The producer relays an INVALID payload (empty questions violates min 1),
    // never a valid one → the dispatch never resolves → produce times out.
    const codexFactory = makeFakeCodexFactory({
      relay: (submitId, phase, payload) => submitProxy.onSubmit({ submitId, phase, payload }),
      payloads: {
        produce: { goal: { description: "x" }, questions: [] },
      },
    });

    const rt = new WorkflowRuntime({
      logger: noopLogger,
      store,
      selectProducer: () =>
        new CodexProducer({
          logger: noopLogger,
          cwd: "/tmp/codex-relay-bad",
          submitProxy,
          internalWsUrl: "ws://127.0.0.1:1/__internal/cq-mcp",
          internalWsToken: "tok",
          nextSubmitId: makeSubmitIdGenerator(99),
          codexFactory,
          timeoutMs: 300, // short — the model never sends a valid payload
        }),
      selectPhaseSubagent: () =>
        new CodexPhaseSubagent({
          logger: noopLogger,
          cwd: "/tmp/codex-relay-bad",
          submitProxy,
          internalWsUrl: "ws://127.0.0.1:1/__internal/cq-mcp",
          internalWsToken: "tok",
          nextSubmitId: makeSubmitIdGenerator(99),
          codexFactory,
          timeoutMs: 300,
        }),
    });

    const res = await rt.startPlan({ text: "build it", platform: "codex" }, () => {});
    expect(res.outcome).toBe("errored");

    // The malformed submit was acked false; NO goal was written.
    expect(acks.length).toBeGreaterThanOrEqual(1);
    expect(acks.some((a) => !a.ok && a.error !== undefined)).toBe(true);
    const goals = store.fetch(GOALS_LEDGER).milestones.flatMap((g) => g.items);
    expect(goals).toHaveLength(0);

    await store.dispose();
  }, 10_000);

  it("continuation producer + append plan run on platform=codex through the relay (fake codex + real proxy)", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();

    const acks: Array<{ ok: boolean }> = [];
    const submitProxy = new WorkflowSubmitProxy({
      logger: noopLogger,
      sendAck: (_submitId, ok) => acks.push({ ok }),
    });

    // Seed a STABLE planned goal: spec + a planner milestone with a task.
    const specM = await store.createMilestone({ title: SPEC_MILESTONE_TITLE, description: "spec" });
    const coreM = await store.createMilestone({ title: "Core", description: "core build" });
    await store.createItem(TASKS_LEDGER, coreM.id, { status: "planned", fields: { headline: "Editor", description: "editor" } });
    const goalItem = await store.createItem(GOALS_LEDGER, specM.id, {
      status: "planned",
      fields: { description: "A notes app.", milestones: [specM.id, coreM.id] },
    });
    const goalId = goalItem.id;
    const originalCoreTask = JSON.stringify(store.listMilestoneItems(coreM.id)[TASKS_LEDGER]);

    // The continuation producer submits under phase "produce" (CONTINUE_SPEC
    // reuses the producer schema + produce phase); the increment planner under
    // "plan"; the clarify + review phases clear/satisfy.
    const codexFactory = makeFakeCodexFactory({
      relay: (submitId, phase, payload) => submitProxy.onSubmit({ submitId, phase, payload }),
      payloads: {
        produce: {
          goal: { description: "A notes app with attachment E2E." },
          questions: [{ question: "Which attachments?", recommendation: "any" }],
        },
        clarify_review: { clear: true, contradictions: [], newQuestions: [] },
        plan: {
          milestones: [{ title: "Attachment E2E", description: "encrypt attachments" }],
          tasks: [{ milestoneRef: 0, headline: "Envelope", description: "key wrap", acceptance: "round-trips" }],
        },
        plan_review: { satisfied: true, findings: [], newQuestions: [] },
      },
    });

    const codexDeps = {
      logger: noopLogger,
      cwd: "/tmp/codex-cont-test",
      submitProxy,
      internalWsUrl: "ws://127.0.0.1:1/__internal/cq-mcp",
      internalWsToken: "tok",
      nextSubmitId: makeSubmitIdGenerator(7000),
      codexFactory,
      timeoutMs: 10_000,
    };

    const rt = new WorkflowRuntime({
      logger: noopLogger,
      store,
      selectProducer: () => new CodexProducer(codexDeps),
      selectPhaseSubagent: () => new CodexPhaseSubagent(codexDeps),
    });

    const res = await rt.continueGoal(goalId, "add attachment E2E", "codex", () => {});
    expect(res.outcome).toBe("questions_ready");
    if (res.outcome !== "questions_ready") throw new Error("unreachable");

    // Increment milestone appended via the Codex relay; originals preserved.
    const goalAfter = store.fetchItem(GOALS_LEDGER, goalId);
    expect(goalAfter.status).toBe("clarifying");
    const ms = goalAfter.fields["milestones"] as string[];
    expect(ms.slice(0, 2)).toEqual([specM.id, coreM.id]);
    const incId = ms[2]!;
    expect(store.fetchMilestone(incId).resolved.title.startsWith(INCREMENT_MILESTONE_PREFIX)).toBe(true);
    const incQ = (store.listMilestoneItems(incId)[QUESTIONS_LEDGER] ?? [])[0]!;

    // Answer → clarify clear → append plan → review satisfied → planned, on Codex.
    await rt.submitAnswer(incQ.id, "any");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (store.fetchItem(GOALS_LEDGER, goalId).status === "planned") break;
      await Bun.sleep(10);
    }
    expect(store.fetchItem(GOALS_LEDGER, goalId).status).toBe("planned");

    const finalMs = store.fetchItem(GOALS_LEDGER, goalId).fields["milestones"] as string[];
    expect(finalMs.slice(0, 2)).toEqual([specM.id, coreM.id]); // originals still a prefix
    expect(finalMs).toHaveLength(4); // spec, core, increment, increment-plan
    const incPlanTasks = store.listMilestoneItems(finalMs[3]!)[TASKS_LEDGER] ?? [];
    expect(incPlanTasks[0]!.fields["headline"]).toBe("Envelope");

    // The original Core task is byte-identical (append-only proof on Codex).
    expect(JSON.stringify(store.listMilestoneItems(coreM.id)[TASKS_LEDGER])).toBe(originalCoreTask);
    expect(acks.every((a) => a.ok)).toBe(true);

    await store.dispose();
  }, 20_000);
});
