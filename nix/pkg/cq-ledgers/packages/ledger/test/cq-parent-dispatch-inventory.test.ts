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
 *   (2) the SAME structured input field set is still composed — the verbatim
 *       `inputSchema` field literal the prompt carried before the removal, so
 *       no input content was lost with the fetch;
 *   (3) `validate_output("<role>", …)` — the (g) leg — is INTACT, with its
 *       failure-consequence prose. (g) is deliberately OUT of T975's scope:
 *       T898 makes implement-worker / implement-reviewer `validate_output`
 *       failures BLOCKING before §6 success interpretation and §7 merge, and it
 *       is the only mechanical check that a worker's evidence payload is not
 *       fabricated (D156). It retires later, in T977/T695, when validation
 *       moves inside `store_result`;
 *   (4) ZERO parent-side prompt materialization and ZERO ordinary
 *       `validate_input` round-trips remain anywhere in the four files.
 *
 * `fetch_prompt` / `validate_input` stay on the MCP surface and in the catalog
 * as explicitly ALLOWLISTED inspection/debug capabilities (the Agents tab, and
 * non-native pi/codex harnesses); (5) below pins that allowlisted path so the
 * removal cannot be mistaken for a capability retirement.
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
  /** The flow whose advance.md owns this dispatch site. */
  readonly flow: FlowKey;
  /** The dispatched-subagent role id. */
  readonly role: string;
  /** The exact catalog-driven-dispatch site marker authored for this edge. */
  readonly siteMarker: string;
  /**
   * The composed structured-input field set, verbatim as the prompt carries it
   * (whitespace-normalized before matching, since the prose line-wraps it).
   * Unchanged by T975 — removing the parent-side fetch must not drop a field.
   */
  readonly inputFields: readonly string[];
}

/** Every native dispatch edge across the four flows — the checked inventory. */
const DISPATCH_EDGES: readonly DispatchEdge[] = [
  {
    flow: "plan",
    role: "plan-advance",
    siteMarker: "Catalog-driven dispatch (G41 — plan-advance)",
    inputFields: ['{ goalId: "<G>" }', "`candidateMode` omitted/false"],
  },
  {
    flow: "plan",
    role: "plan-reviewer",
    siteMarker: "Catalog-driven dispatch (G41 — plan-reviewer)",
    inputFields: ['{ goalId: "<G>" }'],
  },
  {
    flow: "investigate",
    role: "investigate-explorer",
    siteMarker: "Catalog-driven dispatch (G41 — investigate-explorer)",
    inputFields: ["{ hypothesisId, statement, branchContext, leads? }"],
  },
  {
    flow: "investigate",
    role: "investigate-prober",
    siteMarker: "Catalog-driven dispatch (G41 — investigate-prober)",
    inputFields: [
      "{ hypothesisId, statement, probeRequest: { what, why }, branchContext, leads? }",
    ],
  },
  {
    flow: "research",
    role: "research-explorer",
    siteMarker: "Catalog-driven dispatch (research-explorer)",
    inputFields: ["{ hypothesisId, statement, branchContext, leads? }"],
  },
  {
    flow: "research",
    role: "research-experimenter",
    siteMarker: "Catalog-driven dispatch (research-experimenter)",
    inputFields: [
      "{ hypothesisId, statement, probeRequest: { what, why }, branchContext, leads? }",
    ],
  },
  {
    flow: "implement",
    role: "implement-worker",
    siteMarker: "Catalog-driven dispatch (G41 — implement-worker)",
    inputFields: [
      "{ taskId, headline, description, acceptance, worktreePath, branch, baseCommit, priorCriticism? }",
    ],
  },
  {
    flow: "implement",
    role: "implement-reviewer",
    siteMarker: "Catalog-driven dispatch (G41 — implement-reviewer)",
    inputFields: [
      "{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }",
    ],
  },
  {
    flow: "implement",
    role: "implement-conflict-resolver",
    siteMarker: "Catalog-driven dispatch (G41 — implement-conflict-resolver)",
    inputFields: [
      "{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, baseSideNote? }",
    ],
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

/** The failure-consequence clause every surviving (g) call site must keep. */
const VALIDATE_OUT_CONSEQUENCE = "validation failure is a contract breach";

function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
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

function bodyOf(flow: FlowKey): string {
  const body = flowBodies.get(flow);
  if (body === undefined) throw new Error(`no body read for flow ${flow}`);
  return body;
}

describe("T975: native dispatch edges carry no parent-side prompt materialization", () => {
  // (1)–(3) — per dispatch edge.
  for (const edge of DISPATCH_EDGES) {
    it(`${edge.flow}/advance.md still documents the ${edge.role} dispatch site`, () => {
      expect(countOccurrences(bodyOf(edge.flow), edge.siteMarker)).toBe(1);
    });

    it(`${edge.flow}/advance.md still composes the SAME ${edge.role} input field set`, () => {
      const body = normalize(bodyOf(edge.flow));
      for (const fields of edge.inputFields) {
        expect(body).toContain(normalize(fields));
      }
    });

    it(`${edge.flow}/advance.md keeps the ${edge.role} validate_output gate intact`, () => {
      // (g) survives T975 verbatim — T898 hardens it, T977/T695 retire it.
      expect(bodyOf(edge.flow)).toContain(`validate_output("${edge.role}",`);
    });
  }

  // (4) — per flow file: the negative inventory.
  for (const flow of Object.keys(FLOW_FILES) as FlowKey[]) {
    it(`${flow}/advance.md has zero parent-side prompt-fetch / validate_input sites`, () => {
      expect(parentMaterializationViolations(bodyOf(flow))).toEqual([]);
    });

    it(`${flow}/advance.md keeps one validate_output gate per dispatch edge, with its consequence prose`, () => {
      const edges = DISPATCH_EDGES.filter((edge) => edge.flow === flow);
      expect(edges.length).toBeGreaterThan(0);
      expect(countOccurrences(bodyOf(flow), "validate_output(")).toBe(edges.length);
      expect(countOccurrences(normalize(bodyOf(flow)), VALIDATE_OUT_CONSEQUENCE)).toBe(
        edges.length,
      );
    });
  }

  it("plan-advance's validate_output failure gate keeps its strongest apply-nothing prose", () => {
    const body = normalize(bodyOf("plan"));
    expect(body).toContain("apply NOTHING from an invalid result");
    expect(body).toContain("never apply a valid prefix");
    expect(body).toContain("release the claim with `release_plan_claim` kind `abandon`");
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
    // and stays silent on the surviving (g) leg.
    expect(
      parentMaterializationViolations('`validate_output("implement-worker", output)`'),
    ).toEqual([]);
  });

  // (5) — the ALLOWLISTED inspection/debug path is untouched.
  it("keeps fetch_prompt / validate_input / validate_output on the MCP tool surface", () => {
    for (const tool of ["fetch_prompt", "validate_input", "validate_output"] as const) {
      expect(LEDGER_TOOL_NAMES).toContain(tool);
    }
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
});
