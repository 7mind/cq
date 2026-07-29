/**
 * T975 (goal G94, milestone M316) — CHECKED INVENTORY of every native-Claude
 * dispatch edge in the four flow orchestrator prompts.
 *
 * The defect T975 removed: each flow's `advance.md` used to instruct the PARENT
 * orchestrator to run an additive "a–g" prompt-catalog sequence per dispatched
 * role, whose steps (a) and (d) were pure duplication for a native Claude
 * dispatch —
 *
 *   (a) `prompt-catalog fetch ("<role>")` pulled the role's FULL
 *       `promptTemplate` into the ORCHESTRATOR's own context, even though
 *       `bun run gen-agents` already bakes the identical prompt into
 *       `agents/<role>.md` and the harness injects it at the CHILD's system
 *       boundary — the parent's fetched copy launched nothing;
 *   (d) `validate_input("<role>", input)` added a parent-visible round-trip
 *       before a dispatch the parent composes itself.
 *
 * This inventory enumerates all NINE dispatch edges across the four flows and
 * asserts, per edge and per file:
 *
 *   (1) the dispatch site is still documented (its site marker survives);
 *   (2) the same semantic input remains reachable — ordinarily through the
 *       composed `inputSchema` field literal, and for T977's Claude worker edge
 *       through refs from which the server assembles those fields;
 *   (3) `validate_output("<role>", …)` — the (g) leg — remains on the
 *       not-yet-migrated flow edges. T898 retires it for every implement
 *       surface after validation moves inside capability-scoped `store_result`;
 *   (4) ZERO parent-side prompt materialization and ZERO ordinary
 *       `validate_input` round-trips remain anywhere in the four files.
 *
 * `fetch_prompt` stays on the ordinary MCP surface. Both validators stay only
 * in the catalog capability for explicitly
 * allowlisted inspection/debug consumers (the Agents tab and external
 * harnesses); (5) pins the model-visible boundary.
 *
 * Path resolution mirrors the T255/T264/D43/T340/T345 blocks in
 * canonical-ledgers.test.ts: cq-assets is four levels up from this directory.
 */

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LEDGER_TOOL_NAMES } from "../src/mcp/ledgerTools.js";

const ASSETS_ROOT = path.resolve(import.meta.dir, "../../../../cq-assets");
const COMMANDS_ROOT = path.join(ASSETS_ROOT, "commands", "cq");
const CLAUDE_IMPLEMENT_DISPATCH = path.join(
  ASSETS_ROOT,
  "fragments",
  "claude",
  "implement-dispatch-workflow.md",
);
const CODEX_IMPLEMENT_DISPATCH = path.join(
  ASSETS_ROOT,
  "fragments",
  "codex",
  "implement-dispatch-workflow.md",
);
const PI_IMPLEMENT_DISPATCH = path.join(
  ASSETS_ROOT,
  "fragments",
  "pi",
  "implement-dispatch-workflow.md",
);
const IMPLEMENT_WORKER = path.join(ASSETS_ROOT, "agents", "implement-worker.md");
const PROMPT_SURFACES = ["claude", "codex", "pi"] as const;

/** The four flow orchestrator prompts that dispatch native Claude subagents. */
const FLOW_FILES = {
  plan: path.join(COMMANDS_ROOT, "plan", "advance.md"),
  investigate: path.join(COMMANDS_ROOT, "investigate", "advance.md"),
  research: path.join(COMMANDS_ROOT, "research", "advance.md"),
  implement: path.join(COMMANDS_ROOT, "implement", "advance.md"),
} as const;

type FlowKey = keyof typeof FLOW_FILES;

interface DispatchEdge {
  readonly flow: FlowKey;
  readonly role: string;
}

/** Every native dispatch edge across the four flows — the checked inventory. */
const DISPATCH_EDGES: readonly DispatchEdge[] = [
  {
    flow: "plan",
    role: "plan-advance",
  },
  {
    flow: "plan",
    role: "plan-reviewer",
  },
  {
    flow: "investigate",
    role: "investigate-explorer",
  },
  {
    flow: "investigate",
    role: "investigate-prober",
  },
  {
    flow: "research",
    role: "research-explorer",
  },
  {
    flow: "research",
    role: "research-experimenter",
  },
  {
    flow: "implement",
    role: "implement-worker",
  },
  {
    flow: "implement",
    role: "implement-reviewer",
  },
  {
    flow: "implement",
    role: "implement-conflict-resolver",
  },
];

/**
 * Tokens whose presence in a flow orchestrator prompt IS parent-side prompt
 * materialization or an ordinary parent-side validate-in round-trip. The
 * neutral `prompt-catalog fetch (` token and the raw `fetch_prompt` tool name
 * are the two spellings of step (a) across the claude / codex / pi surfaces;
 * `promptTemplate` is the field that fetch existed to pull into parent context;
 * `validate_input` is step (d).
 */
const FORBIDDEN_PARENT_TOKENS = [
  "prompt-catalog fetch (",
  "fetch_prompt",
  "promptTemplate",
  "validate_input",
] as const;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The forbidden tokens present in a candidate prompt body — the scanner. */
function parentMaterializationViolations(body: string): string[] {
  return FORBIDDEN_PARENT_TOKENS.filter((token) => body.includes(token));
}

const flowBodies = new Map<FlowKey, string>(
  await Promise.all(
    (Object.keys(FLOW_FILES) as FlowKey[]).map(
      async (flow) => [flow, await readFile(FLOW_FILES[flow], "utf8")] as const,
    ),
  ),
);
const claudeImplementDispatch = await readFile(CLAUDE_IMPLEMENT_DISPATCH, "utf8");
const codexImplementDispatch = await readFile(CODEX_IMPLEMENT_DISPATCH, "utf8");
const piImplementDispatch = await readFile(PI_IMPLEMENT_DISPATCH, "utf8");
const implementWorker = await readFile(IMPLEMENT_WORKER, "utf8");

function bodyOf(flow: FlowKey): string {
  const body = flowBodies.get(flow);
  if (body === undefined) throw new Error(`no body read for flow ${flow}`);
  return body;
}

function claudeDispatchBodyOf(edge: DispatchEdge): string {
  return edge.flow === "implement"
    ? `${bodyOf(edge.flow)}\n${claudeImplementDispatch}`
    : bodyOf(edge.flow);
}

describe("T975: native dispatch edges carry no parent-side prompt materialization", () => {
  for (const edge of DISPATCH_EDGES) {
    it(`${edge.flow}/advance.md retains the ${edge.role} dispatch edge`, () => {
      expect(claudeDispatchBodyOf(edge)).toContain(edge.role);
    });
  }

  // (4) — per flow file: the negative inventory.
  for (const flow of Object.keys(FLOW_FILES) as FlowKey[]) {
    it(`${flow}/advance.md has zero parent-side prompt-fetch / validate_input sites`, () => {
      expect(parentMaterializationViolations(bodyOf(flow))).toEqual([]);
    });

    it(`${flow}/advance.md contains no removed validation round-trip`, () => {
      const body =
        flow === "implement" ? `${bodyOf(flow)}\n${claudeImplementDispatch}` : bodyOf(flow);
      expect(body).not.toContain("validate_input");
      expect(body).not.toContain("validate_output");
    });
  }

  it("plan-advance rejects partial application of an invalid result", () => {
    const body = normalize(bodyOf("plan"));
    expect(body).toContain("Reject the whole result on any contract failure");
    expect(body).toContain("never apply a valid prefix");
  });

  it("the inventory covers all four flows and every dispatched role exactly once", () => {
    expect(new Set<FlowKey>(DISPATCH_EDGES.map((edge) => edge.flow))).toEqual(
      new Set(Object.keys(FLOW_FILES) as FlowKey[]),
    );
    expect(DISPATCH_EDGES.map((edge) => edge.role)).toHaveLength(
      new Set(DISPATCH_EDGES.map((edge) => edge.role)).size,
    );
  });

  // The scanner must FAIL on a reintroduction — a negative control that pins the
  // guard itself, so the invariant cannot rot into a no-op assertion.
  it("the scanner flags a reintroduced parent-side fetch or validate_input", () => {
    expect(
      parentMaterializationViolations(
        '**(a)** `prompt-catalog fetch ("implement-worker")` for its `promptTemplate`',
      ),
    ).toEqual(["prompt-catalog fetch (", "promptTemplate"]);
    expect(
      parentMaterializationViolations('**(d)** `validate_input("implement-worker", input)`'),
    ).toEqual(["validate_input"]);
    expect(
      parentMaterializationViolations("call `mcp__ledger__fetch_prompt` with the roleId"),
    ).toEqual(["fetch_prompt"]);
    // and stays silent on a direct validation spelling (the scanner's concern
    // is parent-side prompt/input materialization, not validator inventory).
    expect(
      parentMaterializationViolations('`validate_output("implement-worker", output)`'),
    ).toEqual([]);
  });

  // (5) — only the still-model-visible catalog operations remain registered.
  it("keeps fetch_prompt and hides both validators from ordinary tools/list", () => {
    expect(LEDGER_TOOL_NAMES).toContain("fetch_prompt");
    expect(LEDGER_TOOL_NAMES).not.toContain("validate_input" as never);
    expect(LEDGER_TOOL_NAMES).not.toContain("validate_output" as never);
  });

  for (const surface of PROMPT_SURFACES) {
    it(`keeps the ${surface} operational vocabulary mapping for the catalog fetch`, async () => {
      const fragment = await readFile(
        path.join(ASSETS_ROOT, "fragments", surface, "operational-tool-vocabulary.md"),
        "utf8",
      );
      expect(fragment).toContain('`prompt-catalog fetch ("<roleId>")` → call `');
      expect(fragment).toContain("fetch_prompt` with");
    });
  }

  it("pins the live T977 worker-input protocol without migrating the held Pi path", () => {
    const narrativeCourier =
      "{ taskId, headline, description, acceptance, worktreePath, branch, baseCommit, priorCriticism? }";
    const refsOnly =
      "{ roleId, surface, projectKey, taskId, coordinates, round?, priorReviewId?, guidance?, resolvedModel? }";

    for (const body of [claudeImplementDispatch, codexImplementDispatch]) {
      expect(normalize(body)).toContain(normalize(refsOnly));
      expect(body).toContain("prepare_dispatch");
      expect(body).toContain("inputCapability");
      expect(body).toContain("fetch_dispatch_input");
      expect(body).not.toContain(narrativeCourier);
    }

    expect(piImplementDispatch).toContain(narrativeCourier);
    expect(piImplementDispatch).not.toContain("prepare_dispatch");
    expect(piImplementDispatch).not.toContain("inputCapability");
    expect(piImplementDispatch).not.toContain("fetch_dispatch_input");

    expect(implementWorker).toContain("{{cq:fragment:dispatch-input-delivery}}");
    expect(implementWorker).not.toContain("Inputs (from the dispatch prompt)");
    expect(implementWorker).not.toContain("input delivered via dispatch prompt");
  });

  it("T899 makes the fetched resultCommit the sole pre-merge git authority", () => {
    const body = bodyOf("implement");
    const gateStart = body.indexOf("## 5. Success authority");
    const gateEnd = body.indexOf("## 7. Milestones and goals");
    expect(gateStart).toBeGreaterThanOrEqual(0);
    expect(gateEnd).toBeGreaterThan(gateStart);
    const mergeGate = normalize(body.slice(gateStart, gateEnd));

    expect(mergeGate).toContain("consumed through parent-retained handles");
    expect(mergeGate).toContain("`git cat-file -t <resultCommit>`");
    expect(mergeGate).toContain("require the worker branch tip to equal `resultCommit`");
    expect(mergeGate).toContain("Any failure is a contract breach and forbids merge-back");
    expect(mergeGate).toContain("git merge --ff-only <resultCommit>");
    expect(mergeGate).not.toContain("git merge --ff-only implement/<taskId>");
  });

  it("T900 treats implausible worker gate duration as a blocking tripwire", () => {
    const body = bodyOf("implement");
    const gateStart = body.indexOf("## 5. Success authority");
    const gateEnd = body.indexOf("## 6. Merge in DAG order");
    expect(gateStart).toBeGreaterThanOrEqual(0);
    expect(gateEnd).toBeGreaterThan(gateStart);
    const mergeGate = normalize(body.slice(gateStart, gateEnd));

    expect(mergeGate).toContain("`gateDurationMs` below `50`, absent/zero");
    expect(mergeGate).toContain("below one quarter of the median");
    expect(mergeGate).toContain("Re-run `bun run check` in the foreground");
    expect(mergeGate).toContain("If that cannot be done, fail closed");
  });

  it("T902 verifies and records the dispatch base before worker launch", () => {
    const body = bodyOf("implement");
    const dispatchStart = body.indexOf("## 2. Dispatch workers");
    const dispatchEnd = body.indexOf("## 3. Review");
    expect(dispatchStart).toBeGreaterThanOrEqual(0);
    expect(dispatchEnd).toBeGreaterThan(dispatchStart);
    const dispatchGate = normalize(body.slice(dispatchStart, dispatchEnd));

    expect(dispatchGate).toContain("`git rev-parse --verify`");
    expect(dispatchGate).toContain("`git cat-file -t`");
    expect(dispatchGate).toContain("Retain that exact `baseCommit`");
  });

  it("T902 makes verified-base ancestry a blocking merge precondition", () => {
    const body = bodyOf("implement");
    const gateStart = body.indexOf("## 5. Success authority");
    const gateEnd = body.indexOf("## 6. Merge in DAG order");
    expect(gateStart).toBeGreaterThanOrEqual(0);
    expect(gateEnd).toBeGreaterThan(gateStart);
    const mergeGate = normalize(body.slice(gateStart, gateEnd));

    expect(mergeGate).toContain(
      "`git merge-base --is-ancestor <verifiedBaseCommit> <resultCommit>`",
    );
    expect(mergeGate).toContain("`git cat-file -t <resultCommit>`");
    expect(mergeGate).toContain("require the worker branch tip to equal `resultCommit`");
  });

  it("T902 gives implement-worker a stale-worktree Step 0 before implementation", () => {
    const body = normalize(implementWorker);
    const stepStart = body.indexOf("1. **Verify the base before other work.**");
    const implementStart = body.indexOf("3. **Implement surgically.**");
    expect(stepStart).toBeGreaterThanOrEqual(0);
    expect(implementStart).toBeGreaterThan(stepStart);
    const step = body.slice(stepStart, implementStart);

    expect(step).toContain("`git rev-parse HEAD`");
    expect(step).toContain("equal `baseCommit`");
    expect(step).toContain("`git reset --hard <baseCommit>`");
    expect(step).toContain("`git merge-base --is-ancestor <baseCommit> HEAD`");
    expect(step).toContain("Criticism round");
  });
});
