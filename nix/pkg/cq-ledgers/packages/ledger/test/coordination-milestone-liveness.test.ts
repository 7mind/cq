/**
 * End-to-end blackbox regression for D267/T1994 (G165): the
 * investigate-to-review planning round over a coordination milestone.
 *
 * Mirrors D267's topology over the public MCP tool surface (the same
 * handlers the SDK serves): invoke each tool's handler directly and assert
 * the full planning round:
 *  1. A coordination milestone and a defect-seeded planning goal under it.
 *     A premature terminalization of the milestone must reject BEFORE any
 *     mutation — and the milestone must stay writable (no manual reopen).
 *  2. Claim the plan, publish one draft, create the mandatory bound review
 *     under the SAME milestone, and finalize the approved draft — covering
 *     the update_item milestone branch, which delegates to updateMilestone
 *     (D267/T1856).
 *  3. The historical terminal-parent branch: a goal whose coordination
 *     milestone was closed earlier (legacy-inconsistent state) rejects both
 *     claim and publication without partial lifecycle or allocation state —
 *     no claim, draft, task, review, decision, operation-record, or counter
 *     leakage from either rejected branch.
 */

import { describe, expect, it } from "bun:test";
import {
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  createLedgerMcpTools,
  type Item,
  type Ledger,
  type Milestone,
} from "../src/index.js";

const OWNER_TOKEN = "A".repeat(22);

type Tools = ReturnType<typeof createLedgerMcpTools>;

function callTool(
  tools: Tools,
  name: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool not found: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t.handler(args as never, null) as Promise<any>;
}

async function json(result: Promise<{ content: Array<{ type: string; text: string }> }>) {
  const r = await result;
  const first = r.content[0];
  if (first === undefined) throw new Error("empty tool result");
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** Move a goal between milestone groups in the store's in-memory map — the
 * legacy-inconsistent seed: a live goal under a closed parent, exactly the
 * shape D267 found in production (T1855/T1856 fixtures use the same
 * manipulation in their own harnesses). */
function reparentGoal(store: InMemoryLedgerStore, goalId: string, milestoneId: string): void {
  const ledgers = (store as unknown as { ledgers: Map<string, Ledger> }).ledgers;
  const goals = ledgers.get("goals");
  if (goals === undefined) throw new Error("goals ledger missing");
  let moved: Item | undefined;
  for (const milestone of goals.milestones) {
    const index = milestone.items.findIndex((candidate) => candidate.id === goalId);
    if (index >= 0) {
      const candidate = milestone.items[index];
      if (candidate === undefined) throw new Error("unreachable: index from findIndex");
      moved = candidate;
      milestone.items.splice(index, 1);
      break;
    }
  }
  if (moved === undefined) throw new Error(`goal not found: ${goalId}`);
  moved.milestoneId = milestoneId;
  let target: Milestone | undefined = goals.milestones.find((m) => m.id === milestoneId);
  if (target === undefined) {
    target = { id: milestoneId, title: "legacy parent group", description: "", items: [] };
    goals.milestones.push(target);
  }
  target.items.push(moved);
}

describe("coordination milestone liveness (D267/T1994)", () => {
  it("seeded goal survives premature close, then completes claim → publish → review → finalize under the same milestone", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const tools = createLedgerMcpTools(store);

    // Defect-seeded planning goal under its coordination milestone.
    const milestone = await json(
      callTool(tools, "create_item", {
        ledger_id: "milestones",
        status: "open",
        fields: { title: "coordination" },
      }),
    );
    const milestoneId = (milestone["item"] as Record<string, unknown>)["id"] as string;
    await json(
      callTool(tools, "create_item", {
        ledger_id: "defects",
        milestone_id: milestoneId,
        status: "open",
        fields: { headline: "seed defect", severity: "high" },
      }),
    );
    const goal = await json(
      callTool(tools, "create_item", {
        ledger_id: "goals",
        milestone_id: milestoneId,
        status: "planning",
        fields: {
          title: "seeded plan",
          description: "defect-seeded planning goal",
        },
      }),
    );
    const goalId = (goal["item"] as Record<string, unknown>)["id"] as string;

    // Premature close: every child is non-terminal, so the close rejects
    // BEFORE mutation and the milestone stays open — no manual reopen.
    await expect(
      callTool(tools, "update_item", {
        ledger_id: "milestones",
        item_id: milestoneId,
        status: "done",
      }),
    ).rejects.toThrow(/Cannot close milestone/);
    const afterReject = await json(
      callTool(tools, "fetch_item", {
        ledger_id: "milestones",
        item_id: milestoneId,
        projection: "compact",
      }),
    );
    expect((afterReject["item"] as Record<string, unknown>)["status"]).toBe("open");

    // Claim → publish one draft.
    const claim = await json(
      callTool(tools, "claim_plan", {
        goalId,
        purpose: "initial",
        claimRequestId: "t1859-claim",
        ownerFenceToken: OWNER_TOKEN,
        expectedGeneration: null,
        author: "t1859",
        session: "t1859",
      }),
    );
    const claimAck = claim["acknowledgement"] as Record<string, unknown>;
    const claimId = claimAck["claimId"] as string;
    const generation = claimAck["generation"] as number;
    expect(claimAck["goalPhase"]).toBe("planning");

    const publish = await json(
      callTool(tools, "publish_plan_draft", {
        goalId,
        claimId,
        generation,
        operationId: "t1859-publish",
        ownerFenceToken: OWNER_TOKEN,
        author: "t1859",
        session: "t1859",
        manifest: {
          milestones: [{ key: "m1", title: "delivery" }],
          tasks: [{ key: "t1", milestoneKey: "m1", headline: "implement" }],
        },
      }),
    );
    const publishAck = publish["acknowledgement"] as Record<string, unknown>;
    expect((publishAck["manifest"] as Record<string, unknown>)["revision"]).toBe(1);

    // The mandatory bound review is created UNDER the same milestone — the
    // D267 failure mode (review rejected by the closed parent) must not
    // recur: the milestone stayed open.
    const draftIdentity = { goalId, claimId, generation, revision: 1 };
    const review = await json(
      callTool(tools, "create_item", {
        ledger_id: "reviews",
        milestone_id: milestoneId,
        status: "go-ahead",
        fields: {
          summary: "go-ahead for revision 1",
          planDraft: JSON.stringify(draftIdentity),
          ledgerRefs: [`goals:${goalId}`],
        },
      }),
    );
    const reviewId = (review["item"] as Record<string, unknown>)["id"] as string;

    // Finalize: exactly one draft revision and the decision record land.
    const finalize = await json(
      callTool(tools, "finalize_plan", {
        goalId,
        claimId,
        generation,
        operationId: "t1859-finalize",
        ownerFenceToken: OWNER_TOKEN,
        author: "t1859",
        session: "t1859",
        reviewId,
        draftRevision: 1,
        decision: { headline: "adopt revision 1" },
      }),
    );
    const finalizeAck = finalize["acknowledgement"] as Record<string, unknown>;
    expect(finalizeAck["reviewId"]).toBe(reviewId);
    expect(typeof finalizeAck["decisionId"]).toBe("string");

    const goalAfter = await json(
      callTool(tools, "fetch_item", {
        ledger_id: "goals",
        item_id: goalId,
        projection: "full",
      }),
    );
    const goalItem = goalAfter["item"] as Record<string, unknown>;
    expect(goalItem["status"]).toBe("planned");
    const finalizedDraft = JSON.parse(
      (goalItem["fields"] as Record<string, unknown>)["planFinalizedDraft"] as string,
    ) as Record<string, unknown>;
    expect(finalizedDraft["revision"]).toBe(1);

    // The milestone still cannot close (the goal is planned, not done) —
    // and it stays writable, so the flow needs no manual reopen.
    await expect(
      callTool(tools, "update_item", {
        ledger_id: "milestones",
        item_id: milestoneId,
        status: "done",
      }),
    ).rejects.toThrow(/Cannot close milestone/);

    await store.dispose();
  });

  it("historical terminal-parent branch: claim and publication reject without partial lifecycle or allocation state", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const tools = createLedgerMcpTools(store);

    // A closed coordination milestone with a LIVE goal under it — the
    // legacy-inconsistent state D267 found in production.
    const parent = await json(
      callTool(tools, "create_item", {
        ledger_id: "milestones",
        status: "open",
        fields: { title: "legacy parent" },
      }),
    );
    const parentId = (parent["item"] as Record<string, unknown>)["id"] as string;
    await json(
      callTool(tools, "update_item", {
        ledger_id: "milestones",
        item_id: parentId,
        status: "done",
      }),
    );
    const goal = await json(
      callTool(tools, "create_item", {
        ledger_id: "goals",
        milestone_id: MILESTONES_AMBIENT_ID,
        status: "planning",
        fields: { title: "legacy goal", description: "goal under a closed parent" },
      }),
    );
    const goalId = (goal["item"] as Record<string, unknown>)["id"] as string;
    reparentGoal(store, goalId, parentId);
    // Snapshot AFTER the legacy corruption: the rejected branch must leave
    // this exact state (including the orphaned milestoneId) untouched.
    const before = await json(
      callTool(tools, "fetch_item", {
        ledger_id: "goals",
        item_id: goalId,
        projection: "full",
      }),
    );

    // Claim rejects with the typed terminal-parent conflict and leaves no
    // generation, phase, claim, operation, or counter change.
    const rejectedClaim = await json(
      callTool(tools, "claim_plan", {
        goalId,
        purpose: "initial",
        claimRequestId: "t1859-legacy-claim",
        ownerFenceToken: OWNER_TOKEN,
        expectedGeneration: null,
        author: "t1859",
        session: "t1859",
      }),
    );
    expect(rejectedClaim["ok"]).toBe(false);
    expect((rejectedClaim["conflict"] as Record<string, unknown>)["code"]).toBe(
      "parent-milestone-terminal",
    );
    const afterClaim = await json(
      callTool(tools, "fetch_item", {
        ledger_id: "goals",
        item_id: goalId,
        projection: "full",
      }),
    );
    expect(afterClaim["item"]).toEqual(before["item"]);

    // An established claim whose parent is then orphaned rejects publish
    // with no draft revision, operation record, or allocation; the active
    // claim survives untouched.
    const liveGoal = await json(
      callTool(tools, "create_item", {
        ledger_id: "goals",
        milestone_id: MILESTONES_AMBIENT_ID,
        status: "planning",
        fields: { title: "live goal", description: "claimed, then orphaned" },
      }),
    );
    const liveGoalId = (liveGoal["item"] as Record<string, unknown>)["id"] as string;
    const liveClaim = await json(
      callTool(tools, "claim_plan", {
        goalId: liveGoalId,
        purpose: "initial",
        claimRequestId: "t1859-legacy-live-claim",
        ownerFenceToken: OWNER_TOKEN,
        expectedGeneration: null,
        author: "t1859",
        session: "t1859",
      }),
    );
    const liveAck = liveClaim["acknowledgement"] as Record<string, unknown>;
    reparentGoal(store, liveGoalId, parentId);
    const beforeOrphan = await json(
      callTool(tools, "fetch_item", {
        ledger_id: "goals",
        item_id: liveGoalId,
        projection: "full",
      }),
    );
    const rejectedPublish = await json(
      callTool(tools, "publish_plan_draft", {
        goalId: liveGoalId,
        claimId: liveAck["claimId"],
        generation: liveAck["generation"],
        operationId: "t1859-legacy-publish",
        ownerFenceToken: OWNER_TOKEN,
        author: "t1859",
        session: "t1859",
        manifest: {
          milestones: [{ key: "m1", title: "delivery" }],
          tasks: [{ key: "t1", milestoneKey: "m1", headline: "implement" }],
        },
      }),
    );
    expect(rejectedPublish["ok"]).toBe(false);
    expect((rejectedPublish["conflict"] as Record<string, unknown>)["code"]).toBe(
      "parent-milestone-terminal",
    );
    const afterPublish = await json(
      callTool(tools, "fetch_item", {
        ledger_id: "goals",
        item_id: liveGoalId,
        projection: "full",
      }),
    );
    expect(afterPublish["item"]).toEqual(beforeOrphan["item"]);

    // No stray tasks/reviews/decisions leaked from either branch.
    const tasksLedger = await json(
      callTool(tools, "fetch_ledger", { ledger_id: "tasks", projection: "compact" }),
    );
    const reviewsLedger = await json(
      callTool(tools, "fetch_ledger", { ledger_id: "reviews", projection: "compact" }),
    );
    const decisionsLedger = await json(
      callTool(tools, "fetch_ledger", { ledger_id: "decisions", projection: "compact" }),
    );
    const itemCount = (ledgerResult: Record<string, unknown>): number =>
      (
        (ledgerResult["ledger"] as Record<string, unknown>)["milestones"] as Array<{
          items: unknown[];
        }>
      ).flatMap((g) => g.items).length;
    expect(itemCount(tasksLedger)).toBe(0);
    expect(itemCount(reviewsLedger)).toBe(0);
    expect(itemCount(decisionsLedger)).toBe(0);

    await store.dispose();
  });
});
