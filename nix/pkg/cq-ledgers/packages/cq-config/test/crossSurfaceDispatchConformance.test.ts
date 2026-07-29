/**
 * T979 (goal G94, milestone M316) — CROSS-SURFACE conformance of the
 * compact-dispatch sub-graph on claude / codex / pi.
 *
 * T975 removed two parent-side legs from every flow orchestrator prompt — the
 * (a) `prompt-catalog fetch ("<role>")` prompt materialization and the (d)
 * `validate_input("<role>", input)` round-trip — and
 * `packages/ledger/test/cq-parent-dispatch-inventory.test.ts` pins that removal
 * against the CANONICAL sources under `nix/pkg/cq-assets/commands/cq/`.
 *
 * That is not the whole story, because the canonical sources are not what any
 * harness installs. Each surface gets a RENDERED tree
 * (`renderPromptSurfaceTree`) in which per-surface fragments are substituted
 * into the canonical body, so a forbidden token can be reintroduced by a
 * FRAGMENT without touching a canonical source — invisible to the T975 scan.
 * This file scans the RENDERED artifact for all three surfaces, and pins the
 * mechanism each surface uses to get a dispatched role's prompt to its child.
 *
 * Companion evidence, with the exact commands and the live `-p` transcripts:
 *   docs/drafts/20260728-0630-t979-cross-surface-conformance.md
 *
 * WHAT IS PINNED HERE (and what is deliberately only in the report):
 *
 *   CHECK 2 — no ordinary parent-side `validate_input` round-trip survives on
 *     any surface's dispatch path. Pinned as an exact zero on all three
 *     RENDERED surfaces, with a negative control on the scanner.
 *   CHECK 3 — the same semantic input still reaches the child. Pinned per
 *     dispatch edge on all three RENDERED surfaces; T977's Claude/Codex worker
 *     edge carries refs from which the server assembles the narrative, while
 *     the held Pi edge retains direct typed input.
 *   CHECK 1 — the role prompt is injected once at the CHILD boundary and does
 *     not enter parent context. Only the STATIC substrate is pinnable here: the
 *     identical dispatched-role set per surface, and the per-surface injection
 *     MECHANISM (pi's `dispatch_agent` parameter shape, codex's skill
 *     instruction). Whether a live parent's context actually stayed clean is a
 *     RUNTIME property; it was measured with real `-p` turns and the sentinel
 *     counts live in the report, NOT here.
 *
 * The codex assertion below is a CHARACTERIZATION of a KNOWN NON-CONFORMANCE,
 * not an endorsement: the codex skill projection instructs the PARENT to read a
 * dispatched role's prompt into its own context, which is exactly the leg T975
 * removed for claude. It is asserted so the divergence cannot change silently.
 * WHEN THAT IS FIXED, THIS ASSERTION MUST BE INVERTED, not deleted.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { DISPATCHED_ROLE_VERSIONS } from "@cq/config";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput,
} from "@cq/config/prompt-renderer";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const CODEX_SKILL_PROJECTION = path.join(REPO_ROOT, "nix", "lib", "codex-command-skills.nix");
const PI_DISPATCH_EXTENSION = path.join(
  REPO_ROOT,
  "nix",
  "pkg",
  "pi-extensions",
  "cq-subagent-dispatch.ts",
);
const PROMPT_SURFACES = ["claude", "codex", "pi"] as const;
type PromptSurface = (typeof PROMPT_SURFACES)[number];

/** Timeout mirroring the sibling packaged*PromptRoot tests, which also shell out to `nix eval`. */
const NIX_EVAL_TIMEOUT_MS = 60_000;

interface CatalogRole {
  readonly roleId: string;
  readonly roleKind: "dispatched-subagent" | "orchestrator-command";
  readonly canonicalSource: string;
}

interface FragmentSource {
  readonly surface: string;
  readonly roleId: string;
  readonly fragment: string;
  readonly source: string;
}

function evaluateNixRaw(attribute: string): string {
  const result = Bun.spawnSync(["nix", "eval", "--raw", `.#llmAssets.${attribute}`], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`nix eval ${attribute}: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trimEnd();
}

const catalogJson = evaluateNixRaw("catalogJson");
const catalog = JSON.parse(catalogJson) as readonly CatalogRole[];
const fragmentSources = JSON.parse(
  evaluateNixRaw("promptFragmentSourcesJson"),
) as readonly FragmentSource[];

const DISPATCHED_ROLES = catalog.filter(({ roleKind }) => roleKind === "dispatched-subagent");
const COMMAND_ROLES = catalog.filter(({ roleKind }) => roleKind === "orchestrator-command");

const sourcePaths: PromptCatalogFileInput[] = catalog.map((role) => ({
  canonicalSource: role.canonicalSource,
  path: path.join(ASSETS_ROOT, role.canonicalSource),
}));

/** The rendered `roles/<roleId>.md` bodies of one surface, keyed by roleId. */
function renderSurface(surface: PromptSurface): ReadonlyMap<string, string> {
  const fragmentPaths: PromptFragmentFileInput[] = fragmentSources
    .filter((entry) => entry.surface === surface)
    .map(({ roleId, fragment, source }) => ({
      roleId,
      fragment,
      path: path.join(ASSETS_ROOT, source),
    }));
  const tree = renderPromptSurfaceTree({
    surface,
    catalogJson,
    sourcePaths,
    fragmentPaths,
    roleVersions: DISPATCHED_ROLE_VERSIONS,
  });
  const rendered = new Map<string, string>();
  for (const artifact of tree.artifacts) {
    if (!artifact.path.startsWith("roles/")) continue;
    rendered.set(artifact.path.slice("roles/".length).replace(/\.md$/, ""), artifact.content);
  }
  return rendered;
}

const RENDERED: ReadonlyMap<PromptSurface, ReadonlyMap<string, string>> = new Map(
  PROMPT_SURFACES.map((surface) => [surface, renderSurface(surface)] as const),
);

function renderedOf(surface: PromptSurface, roleId: string): string {
  const body = RENDERED.get(surface)!.get(roleId);
  if (body === undefined) {
    throw new Error(`surface ${surface} rendered no body for role ${roleId}`);
  }
  return body;
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

const normalize = (text: string): string => text.replace(/\s+/g, " ");

/**
 * The (d) leg. Unlike the (a)-leg spellings below this token has NO legitimate
 * home in any rendered orchestrator body — not in a canonical source and not in
 * a surface fragment — so its count is an unconditional zero on every surface.
 */
const VALIDATE_IN_TOKEN = "validate_input";

/**
 * Per-surface EXACT occurrence counts of the (a)-leg spellings across all 15
 * rendered orchestrator commands, with their provenance. These are
 * characterization numbers: a real reintroduced parent-side call site moves
 * one of them, which forces a review rather than passing silently.
 *
 * Provenance of every non-zero count below (measured, see the report §4):
 *  - `prompt-catalog fetch (` / `fetch_prompt` = 5 each on EVERY surface: the
 *    `operational-tool-vocabulary` fragment's ALLOWLISTED glossary line, which
 *    T975 §(5) deliberately keeps, substituted into the five commands that
 *    declare that slot.
 *  - `promptTemplate` = 3 on every surface from the CANONICAL sources: the two
 *    portable-rubric commands (`plan-review` x1, `implement-review` x2) that
 *    exist to hand a promptTemplate to a non-Claude harness.
 *  - pi ONLY: +8 `fetch_prompt` and +8 `promptTemplate` from pi's
 *    `inline-command-recursion` fragment, which resolves an INLINE
 *    `CQ::<path>` ORCHESTRATOR-COMMAND through `fetch_prompt("<path>")`.
 *    That is a different artifact class from a dispatched role prompt (see the
 *    report's divergence D-2), and it is why claude/codex and pi differ here.
 */
const EXPECTED_A_LEG_COUNTS: Readonly<
  Record<PromptSurface, Readonly<Record<string, number>>>
> = {
  claude: { "prompt-catalog fetch (": 5, fetch_prompt: 5, promptTemplate: 3 },
  codex: { "prompt-catalog fetch (": 5, fetch_prompt: 5, promptTemplate: 3 },
  pi: { "prompt-catalog fetch (": 5, fetch_prompt: 13, promptTemplate: 11 },
};

/**
 * The verbatim structured-input field literals per dispatch edge, re-asserted
 * on each RENDERED surface so a fragment substitution cannot drop one.
 */
const DISPATCH_EDGE_INPUTS: readonly {
  readonly flowRoleId: string;
  readonly role: string;
  readonly inputFields: readonly string[];
}[] = [
  {
    flowRoleId: "plan/advance",
    role: "plan-advance",
    inputFields: ['{ goalId: "<G>" }', "`candidateMode` omitted/false"],
  },
  { flowRoleId: "plan/advance", role: "plan-reviewer", inputFields: ['{ goalId: "<G>" }'] },
  {
    flowRoleId: "investigate/advance",
    role: "investigate-explorer",
    inputFields: ["{ hypothesisId, statement, branchContext, leads? }"],
  },
  {
    flowRoleId: "investigate/advance",
    role: "investigate-prober",
    inputFields: [
      "{ hypothesisId, statement, probeRequest: { what, why }, branchContext, leads? }",
    ],
  },
  {
    flowRoleId: "research/advance",
    role: "research-explorer",
    inputFields: ["{ hypothesisId, statement, branchContext, leads? }"],
  },
  {
    flowRoleId: "research/advance",
    role: "research-experimenter",
    inputFields: [
      "{ hypothesisId, statement, probeRequest: { what, why }, branchContext, leads? }",
    ],
  },
  {
    flowRoleId: "implement/advance",
    role: "implement-worker",
    inputFields: [
      "{ taskId, headline, description, acceptance, worktreePath, branch, baseCommit, priorCriticism? }",
    ],
  },
  {
    flowRoleId: "implement/advance",
    role: "implement-reviewer",
    inputFields: [
      "{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }",
    ],
  },
  {
    flowRoleId: "implement/advance",
    role: "implement-conflict-resolver",
    inputFields: [
      "{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, baseSideNote? }",
    ],
  },
];

const T977_WORKER_REFS =
  "{ roleId, surface, projectKey, taskId, coordinates, round?, priorReviewId?, guidance?, resolvedModel? }";

describe("T979: the compact-dispatch sub-graph across claude / codex / pi", () => {
  it(
    "renders all three surfaces from one catalog: 9 dispatched roles + 15 orchestrator commands",
    () => {
      expect(DISPATCHED_ROLES).toHaveLength(9);
      expect(COMMAND_ROLES).toHaveLength(15);
      // The dispatched-role SET is identical per surface — the precondition for
      // comparing the surfaces at all.
      const expected = DISPATCHED_ROLES.map(({ roleId }) => roleId);
      for (const surface of PROMPT_SURFACES) {
        const rendered = RENDERED.get(surface)!;
        expect(rendered.size).toBe(catalog.length);
        for (const roleId of expected) {
          expect(rendered.get(roleId)!.length).toBeGreaterThan(0);
        }
      }
    },
    NIX_EVAL_TIMEOUT_MS,
  );

  // ── CHECK 2 — the (d) leg is gone on every surface ──────────────────────
  for (const surface of PROMPT_SURFACES) {
    it(`${surface}: no rendered orchestrator command carries a parent-side ${VALIDATE_IN_TOKEN} round-trip`, () => {
      for (const role of COMMAND_ROLES) {
        expect(countOccurrences(renderedOf(surface, role.roleId), VALIDATE_IN_TOKEN)).toBe(0);
      }
    });

    it(`${surface}: no rendered dispatched-role prompt carries a ${VALIDATE_IN_TOKEN} round-trip either`, () => {
      // A worker asked to self-validate its own input would reintroduce the
      // same round-trip one hop down; the child side must be zero too.
      for (const role of DISPATCHED_ROLES) {
        expect(countOccurrences(renderedOf(surface, role.roleId), VALIDATE_IN_TOKEN)).toBe(0);
      }
    });

    it(`${surface}: the (a)-leg spellings occur only at their known allowlisted provenance`, () => {
      for (const [token, expectedCount] of Object.entries(EXPECTED_A_LEG_COUNTS[surface])) {
        const total = COMMAND_ROLES.reduce(
          (sum, role) => sum + countOccurrences(renderedOf(surface, role.roleId), token),
          0,
        );
        expect(total).toBe(expectedCount);
      }
    });
  }

  it("the validate_input scanner is not a no-op: it flags a reintroduced round-trip", () => {
    // Negative control, mirroring T975's — pins the guard itself.
    expect(
      countOccurrences('**(d)** `validate_input("implement-worker", input)`', VALIDATE_IN_TOKEN),
    ).toBe(1);
    expect(
      countOccurrences('`validate_output("implement-worker", output)`', VALIDATE_IN_TOKEN),
    ).toBe(0);
  });

  it("T898 gates implement success on the parent-minted consumed result on every surface", () => {
    const consumedGate =
      'ONLY when `fetch_dispatch_result` returns `state: "consumed"` with the server-validated body';
    const parentHandle =
      "retain the exact `attestationId` and `generation` from that orchestrator's `prepare_dispatch` response";
    const rejectedStates = [
      "prepared",
      "result-stored",
      "aborted",
      "terminal-envelope-expired",
      "attestation-not-found",
      "output-already-materialized",
    ] as const;

    for (const surface of PROMPT_SURFACES) {
      const rendered = renderedOf(surface, "implement/advance");
      const normalized = normalize(rendered);
      expect(countOccurrences(normalized, normalize(consumedGate))).toBe(1);
      expect(normalized).toContain(normalize(parentHandle));
      expect(normalized).toContain(
        normalize(
          "Never select a result with an attestation id, generation, capability, or token reported by the child.",
        ),
      );
      for (const state of rejectedStates) {
        expect(rendered).toContain(`\`${state}\``);
      }
      expect(rendered).not.toContain('validate_output("implement-worker",');
      expect(rendered).not.toContain('validate_output("implement-reviewer",');
    }
  });

  it("T898 makes worker and reviewer bodies store-only with handle-only completion", () => {
    for (const surface of PROMPT_SURFACES) {
      for (const role of ["implement-worker", "implement-reviewer"] as const) {
        const rendered = normalize(renderedOf(surface, role));
        expect(rendered).toContain(
          normalize(
            "call the capability-scoped `store_result` exactly once with `{ output: <payload> }`",
          ).replace("<payload>", role === "implement-worker" ? "<payload>" : "<verdict>"),
        );
        expect(rendered).toContain("The final message is never the handover channel");
        expect(rendered).toContain("carries only the prepared dispatch handle");
        expect(rendered).not.toContain("structured JSON result block as final reply content");
        expect(rendered).not.toContain("structured JSON verdict block as final reply content");
      }
    }
  });

  // ── CHECK 3 — the structured input survives the render, per surface ─────
  for (const surface of PROMPT_SURFACES) {
    it(`${surface}: every dispatch edge carries its expected structured prepare input`, () => {
      for (const edge of DISPATCH_EDGE_INPUTS) {
        const body = normalize(renderedOf(surface, edge.flowRoleId));
        const refsOnlyWorker = surface !== "pi" && edge.role === "implement-worker";
        const expectedFields = refsOnlyWorker ? [T977_WORKER_REFS] : edge.inputFields;
        for (const fields of expectedFields) {
          expect(body).toContain(normalize(fields));
        }
        if (edge.role === "implement-worker") {
          const narrativeFields = normalize(edge.inputFields[0]!);
          if (refsOnlyWorker) {
            expect(body).not.toContain(narrativeFields);
          } else {
            expect(body).not.toContain(normalize(T977_WORKER_REFS));
          }
        }
      }
    });
  }

  it("T977 renders one-shot fetch for Claude/Codex and direct delivery for the held Pi worker", () => {
    for (const surface of ["claude", "codex"] as const) {
      const worker = renderedOf(surface, "implement-worker");
      expect(countOccurrences(worker, "fetch_dispatch_input")).toBe(1);
      expect(worker).toContain("exactly once");
      expect(worker).not.toContain("passes the complete typed worker input directly");
    }
    const piWorker = renderedOf("pi", "implement-worker");
    expect(countOccurrences(piWorker, "fetch_dispatch_input")).toBe(0);
    expect(piWorker).toContain("passes the complete typed worker input directly");
    expect(piWorker).not.toContain("call `fetch_dispatch_input` exactly once");
  });

  // ── CHECK 1 — the per-surface child-boundary injection MECHANISM ────────
  it("pi injects a dispatched role at the child boundary, by NAME, from extension code", () => {
    const extension = readFileSync(PI_DISPATCH_EXTENSION, "utf8");
    // The tool the pi surface's `CQ_SUBAGENT` token names.
    expect(extension).toContain('const DISPATCH_TOOL_NAME = "dispatch_agent"');
    // Its parameter object is the load-bearing part: the parent can name a role
    // and a task, and has NO parameter through which it could pass a prompt
    // BODY. That is what keeps the role prompt out of parent context.
    const parameterBlock = extension.slice(
      extension.indexOf("const DispatchParams = Type.Object({"),
      extension.indexOf("type DispatchArgs"),
    );
    expect(parameterBlock.length).toBeGreaterThan(0);
    for (const parameter of ["agent:", "task:", "model:", "isolation:"] as const) {
      expect(parameterBlock).toContain(parameter);
    }
    for (const forbidden of ["prompt:", "systemPrompt:", "promptTemplate", "body:"] as const) {
      expect(parameterBlock).not.toContain(forbidden);
    }
    // The body is read by EXTENSION code from the projected agents dir and
    // handed to the child as an appended SYSTEM prompt — never returned to,
    // or routed through, the parent model.
    expect(extension).toContain('childArgs.push("--append-system-prompt", tmp.filePath)');
    expect(extension).toContain("systemPrompt: body");
  });

  it("codex NO LONGER instructs the PARENT to read a dispatched role's prompt — T979 divergence D-1 CLOSED", () => {
    // INVERTED (not deleted) by tasks:T691, exactly as the prior wording
    // instructed: "INVERT this assertion when the divergence is fixed; do not
    // delete it."
    //
    // WAS a characterization of a KNOWN NON-CONFORMANCE (T979 divergence D-1):
    // the codex skill projection told the ORCHESTRATOR to pull a dispatched
    // role's full prompt into its own context before dispatching — the exact
    // (a) leg tasks:T975 removed for claude, reintroduced by a different
    // mechanism. Measured live at the time: the parent's own `-p` transcript
    // contained the role-body sentinel.
    //
    // defects:D178 half (a) removed that advertisement and half (b) supplied
    // the replacement delivery path (a global native-agent declaration), and
    // researches:RS11 measured why they are INSEPARABLE — shipping (a) alone
    // leaves children un-roled, executing the 43.5 KB orchestrator workflow
    // and then failing to spawn. Both halves shipped together in T691.
    //
    // Keeping this as a NEGATIVE assertion rather than deleting it is what
    // makes a re-advertisement regression fail here instead of passing
    // silently.
    const projection = readFileSync(CODEX_SKILL_PROJECTION, "utf8");
    expect(projection).not.toContain("Read that role reference completely");
    expect(projection).not.toContain(
      "before dispatching it through the collaboration transport",
    );

    // ...and neither of the conformant surfaces carries an equivalent
    // parent-read instruction for a dispatched role.
    for (const conformant of ["claude", "pi"] as const) {
      const dispatchFragment = readFileSync(
        path.join(ASSETS_ROOT, "fragments", conformant, "subagent-dispatch.md"),
        "utf8",
      );
      expect(dispatchFragment).not.toContain("Read that role reference");
      expect(dispatchFragment).toContain("Never simulate the delegated role");
    }
  });

  it("every surface's dispatch fragment names a transport that takes a role id, not a prompt body", () => {
    // The three transports differ, but all three are role-NAME-addressed. The
    // codex divergence above is in the SKILL wrapper, not in this fragment.
    const expectations: Readonly<Record<PromptSurface, string>> = {
      claude: 'CQ_SUBAGENT(role: "<role>", handle: <dispatch-handle>, model: <model>)',
      codex: "`spawn_agent` transport",
      pi: 'dispatch_agent(agent: "<role>", task: "<complete prompt>")',
    };
    for (const surface of PROMPT_SURFACES) {
      const fragment = readFileSync(
        path.join(ASSETS_ROOT, "fragments", surface, "subagent-dispatch.md"),
        "utf8",
      );
      expect(fragment).toContain(expectations[surface]);
      expect(fragment).toContain("CQ_SUBAGENT");
    }
  });
});
