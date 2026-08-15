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
import { DISPATCHED_ROLE_VERSIONS, DISPATCHED_ROLE_SIDECARS } from "@cq/config";
import {
  renderPromptSurfaceTree,
  type PromptCatalogFileInput,
  type PromptFragmentFileInput, serializeRoleSchemaArtifact} from "@cq/config/prompt-renderer";


const DISPATCHED_ROLE_SCHEMAS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.values(DISPATCHED_ROLE_SIDECARS).map((sidecar) => [
      sidecar.id,
      serializeRoleSchemaArtifact(sidecar),
    ]),
  ),
);

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");
const CODEX_SKILL_PROJECTION = path.join(REPO_ROOT, "nix", "lib", "codex-command-skills.nix");
const PI_DISPATCH_EXTENSION = path.join(
  REPO_ROOT,
  "nix",
  "pkg",
  "pi-extensions",
  "cq-subagent-dispatch",
  "index.ts",
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
    roleSchemas: DISPATCHED_ROLE_SCHEMAS });
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

const EXPLORER_ROLES = ["investigate-explorer", "research-explorer"] as const;

type LostReportViolation =
  | "missing-operational-definition"
  | "missing-contract-breach-log"
  | "missing-single-retry"
  | "missing-second-loss-fail-closed"
  | "missing-result-classification";

function lostReportContractViolations(body: string): readonly LostReportViolation[] {
  const normalized = normalize(body);
  const required: readonly [LostReportViolation, string][] = [
    ["missing-operational-definition", "A missing or non-consumed native result is a LOST REPORT"],
    ["missing-contract-breach-log", "Log it"],
    ["missing-single-retry", "retry the same role once with a fresh prepared dispatch"],
    ["missing-second-loss-fail-closed", "A second loss fails that task path closed"],
    [
      "missing-result-classification",
      "cannot become a worker failure, reviewer abstention, or resolver verdict",
    ],
  ];

  return required.flatMap(([violation, needle]) =>
    normalized.includes(normalize(needle)) ? [] : [violation],
  );
}

const REMOVED_VALIDATION_TOKENS = ["validate_input", "validate_output"] as const;

const DISPATCH_EDGE_INPUTS: readonly {
  readonly flowRoleId: string;
  readonly role: string;
}[] = [
  { flowRoleId: "plan/advance", role: "plan-advance" },
  { flowRoleId: "plan/advance", role: "plan-reviewer" },
  { flowRoleId: "investigate/advance", role: "investigate-explorer" },
  { flowRoleId: "investigate/advance", role: "investigate-prober" },
  { flowRoleId: "research/advance", role: "research-explorer" },
  { flowRoleId: "research/advance", role: "research-experimenter" },
  { flowRoleId: "implement/advance", role: "implement-worker" },
  { flowRoleId: "implement/advance", role: "implement-reviewer" },
  { flowRoleId: "implement/advance", role: "implement-conflict-resolver" },
];

const T977_WORKER_REFS =
  "{ roleId, surface, projectKey, taskId, coordinates, round, startingCommit, priorReviewId?, guidance?, resolvedModel? }";

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

  for (const surface of PROMPT_SURFACES) {
    it(`${surface}: removed validation round-trips stay absent from rendered prompts`, () => {
      for (const role of COMMAND_ROLES) {
        for (const token of REMOVED_VALIDATION_TOKENS) {
          expect(countOccurrences(renderedOf(surface, role.roleId), token)).toBe(0);
        }
      }
      for (const role of DISPATCHED_ROLES) {
        for (const token of REMOVED_VALIDATION_TOKENS) {
          expect(countOccurrences(renderedOf(surface, role.roleId), token)).toBe(0);
        }
      }
    });
  }

  it("the removed-validation scanner has a positive control", () => {
    for (const token of REMOVED_VALIDATION_TOKENS) {
      expect(countOccurrences(`${token}("implement-worker", value)`, token)).toBe(1);
    }
  });

  it("T898 gates implement success on the parent-minted consumed result on every surface", () => {
    for (const surface of PROMPT_SURFACES) {
      const normalized = normalize(renderedOf(surface, "implement/advance"));
      expect(normalized).toContain("Retain the parent-prepared handle");
      expect(normalized).toContain('state: "consumed"');
      expect(normalized).toContain(
        normalize("Never inspect a body-returning completion or trust a child-reported handle."),
      );
    }
  });

  it("T901 retries a missing required native report once, then fails closed", () => {
    for (const surface of PROMPT_SURFACES) {
      const rendered = renderedOf(surface, "implement/advance");
      expect(lostReportContractViolations(rendered)).toEqual([]);
      expect(rendered).not.toContain(
        "treat a worker as failed or a reviewer as abstaining, according to the existing routing below",
      );
    }
  });

  it("T901 guard rejects progress-only success and a second retry", () => {
    const real = renderedOf("codex", "implement/advance");
    const secondRetry = real.replace(
      /retry\s+the same role once with a fresh prepared dispatch/,
      "retry the same role twice with fresh prepared dispatches",
    );
    expect(lostReportContractViolations(secondRetry)).toContain("missing-single-retry");
  });

  it("T898 makes worker and reviewer bodies store-only with handle-only completion", () => {
    for (const surface of PROMPT_SURFACES) {
      for (const role of ["implement-worker", "implement-reviewer"] as const) {
        const rendered = normalize(renderedOf(surface, role));
        expect(rendered).toContain("dispatch-scoped `store_result` tool");
        expect(rendered).toContain("reply with the prepared dispatch handle only");
        expect(rendered).toContain("never return the");
        expect(rendered).toContain("body or a capability");
        expect(rendered).not.toContain("structured JSON result block as final reply content");
        expect(rendered).not.toContain("structured JSON verdict block as final reply content");
      }
    }
  });

  it("T901 makes the conflict-resolver result store-only with handle-only completion", () => {
    for (const surface of PROMPT_SURFACES) {
      const rendered = normalize(renderedOf(surface, "implement-conflict-resolver"));
      expect(rendered).toContain("dispatch-scoped `store_result` tool");
      expect(rendered).toContain("reply with the prepared dispatch handle only");
      expect(rendered).toContain("never return the result body or a capability");
      expect(rendered).not.toContain("structured JSON result block as final reply content");
      expect(rendered).not.toContain("Emit the **Session summary** section");
      expect(rendered).not.toContain("return a single fenced `json` block");
    }

    const heldPiAdvance = normalize(renderedOf("pi", "implement/advance").replace(/^>\s?/gm, ""));
    // Pi held freeform is parent-verified authoritative; no unconditional bailout.
    expect(heldPiAdvance).toContain(normalize("held freeform"));
    expect(heldPiAdvance).toContain(normalize("parent verification"));
    expect(heldPiAdvance).toContain(normalize("Do not bail out solely"));
    expect(heldPiAdvance).not.toContain(
      normalize(
        "never interpret the held adapter's raw completion. Enter the bailout until the extension-local lifecycle can return a consumed fetched body.",
      ),
    );
  });

  it("T1629/T1307 binds every worker round to its authoritative starting commit", () => {
    for (const surface of PROMPT_SURFACES) {
      const worker = normalize(renderedOf(surface, "implement-worker"));
      expect(worker).toContain("Step 0 — verify prepared evidence only");
      expect(worker).toContain("`git rev-parse HEAD`");
      expect(worker).toContain("equals `startingCommit`");
      expect(worker).not.toContain("`git reset --hard <baseCommit>`");
      expect(worker).toContain("`git merge-base --is-ancestor <baseCommit> HEAD`");
      expect(worker).toContain("baseVerification");
      expect(worker).not.toMatch(/\brun `bun install`/);
      expect(worker).toContain(
        '`cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check`',
      );
      expect(worker).toContain(
        "A yielded command-session handle remains the sole full-gate attempt",
      );
      expect(worker).toContain("poll that exact session or explicitly terminate it");
      expect(worker).toContain("before retrying the gate, calling `store_result`, or returning");
      expect(worker).toContain("`git merge-base --is-ancestor <startingCommit> <resultCommit>`");
      expect(worker).toContain(
        '`{"attestationId":"<prepared attestation id>","generation":<prepared generation>}`',
      );

      const advance = normalize(renderedOf(surface, "implement/advance"));
      expect(advance).toContain("`git rev-parse --verify`");
      expect(advance).toContain("`git cat-file -t`");
      expect(advance).toContain("startingCommit");
      expect(advance).toContain("worktree `HEAD` to equal that retained `startingCommit`");
      expect(advance).toContain("worktree_manage");
      expect(advance).toContain('operation: "prepare"');
      expect(advance).toContain(
        "`git merge-base --is-ancestor <verifiedBaseCommit> <startingCommit>`",
      );
      expect(advance).toContain(
        "`git merge-base --is-ancestor <verifiedBaseCommit> <resultCommit>`",
      );
      expect(
        countOccurrences(advance, "`git merge-base --is-ancestor <startingCommit> <resultCommit>`"),
      ).toBeGreaterThanOrEqual(2);
      expect(advance).toContain("forbids merge-back");
      expect(advance).not.toContain("git worktree add ");
      expect(advance).not.toContain("git worktree remove");
      expect(advance).not.toContain("git worktree prune");
      expect(advance).toContain("worktree_manage");
    }
  });

  it("T2052 exposes exact pre-registry adoption on every implement/advance surface", () => {
    for (const surface of PROMPT_SURFACES) {
      const advance = normalize(renderedOf(surface, "implement/advance"));
      expect(advance).toContain("pre-registry");
      expect(advance).toContain("adoptWorktreePath");
      expect(advance).toContain("expectedHead");
      expect(advance).toContain("handle-free prepare");
      expect(advance).toContain("Retain the returned opaque handle");
      expect(advance).not.toContain("git worktree add ");
      expect(advance).not.toContain("git worktree remove");
      expect(advance).not.toContain("git worktree prune");
    }
  });

  it("T2053/T2058/T2066 keep revisioned operator actions in one parent-only lifecycle", () => {
    for (const surface of PROMPT_SURFACES) {
      const advance = normalize(renderedOf(surface, "implement/advance"));
      expect(advance).toContain("CQ-OPERATOR-ACTION v1 <action-key>.");
      expect(advance).toContain("deployed-recovery");
      expect(advance).toContain("materialize_operator_action");
      expect(advance).toContain("acknowledge_operator_action");
      expect(advance).toContain("revise_operator_action");
      expect(advance).toContain("record_operator_action_evidence");
      expect(advance).toContain("complete_operator_action");
      expect(advance).toContain("expected_revision");
      expect(advance).toContain("complete replacement contract");
      expect(advance).toContain("prior action/task/handoff snapshot");
      expect(advance).toContain("terminal evidence entry and `lastFailure`");
      expect(advance).toContain("current revision and acknowledgement epoch");
      expect(advance).toContain("successful partial evidence");
      expect(advance).toContain("fail closed on malformed, stale, or inconsistent audit state");
      expect(advance).not.toContain("Never revise after evidence");
      expect(advance).toContain("the user performs deployment");
      expect(advance).toContain("this parent runs bounded shell probes");
      expect(advance).toContain("MUST NOT enter worktree preparation");
      expect(advance).toContain("never `pImplement`");
    }
  });

  it("T1629 orders bounded Codex invalid-output diagnostics before protocol abort", () => {
    const advance = normalize(renderedOf("codex", "implement/advance"));
    const stored = advance.indexOf("observe the `result-stored` acknowledgement");
    const logged = advance.indexOf("`cq log put`", stored);
    const aborted = advance.indexOf("`abort_dispatch` with reason `protocol-violation`", logged);
    expect(stored).toBeGreaterThanOrEqual(0);
    expect(logged).toBeGreaterThan(stored);
    expect(aborted).toBeGreaterThan(logged);
    const invalidOutputContract = advance.slice(stored, aborted);
    expect(invalidOutputContract).not.toContain("fetch_dispatch_result");
    expect(invalidOutputContract).not.toContain("consume_dispatch_result");
    expect(invalidOutputContract).not.toContain("result body");
  });

  it("T903/T1308 pins reviewer evidence as blocking and independently verifies commit object plus tip and ancestry", () => {
    for (const surface of PROMPT_SURFACES) {
      const reviewer = normalize(renderedOf(surface, "implement-reviewer"));
      expect(reviewer).toContain(
        "Always state `gateReRan`, `resultCommitVerified`, `resultCommitEvidence`, and",
      );
      expect(reviewer).toContain("resultCommitEvidence");
      expect(reviewer).toContain("baseAncestry");
      expect(reviewer).toContain("cat-file -t");
      expect(reviewer).toContain(
        "`git -C <worktree> rev-parse --verify <branch>` and require its full SHA",
      );
      expect(reviewer).toContain(
        "`git merge-base --is-ancestor <baseCommit> <resultCommit>`",
      );
    }
  });

  it("T2007 pins parent-attested sandbox-denied gate path while preserving child re-run prose", () => {
    for (const surface of PROMPT_SURFACES) {
      const reviewer = normalize(renderedOf(surface, "implement-reviewer"));
      expect(reviewer).toContain("parentGateAttestation");
      expect(reviewer).toContain("sandbox-denied-primitives");
      expect(reviewer).toContain(
        "`cq gate run --worktree <worktree> --command-cwd <worktree>/nix/pkg/cq-ledgers --deadline <gateCompleteBy> -- bun run check`",
      );
      expect(reviewer).toContain("Non-sandboxed reviewers always take this child re-run path");
    }
    const codexAdvance = normalize(renderedOf("codex", "implement/advance"));
    expect(codexAdvance).toContain("parentGateAttestation");
    expect(codexAdvance).toContain("danger-full-access");
    expect(codexAdvance).toContain("gateReRan=true");
  });

  it("T903 pins the implausible-duration classification and foreground-rerun response", () => {
    for (const surface of PROMPT_SURFACES) {
      const advance = normalize(renderedOf(surface, "implement/advance"));
      expect(advance).toContain(
        normalize(
          "Treat `gateDurationMs` below `50`, absent/zero, or below one quarter of the median for earlier rounds of this same task as implausible.",
        ),
      );
      expect(advance).toContain(
        normalize("Re-run `bun run check` in the foreground and use its real exit status."),
      );
    }
  });

  it("T1696 preserves one prepare-bound reviewer phase and its exact exhaustion evidence", () => {
    const exhaustion =
      "Implementation-review phase budget exhausted before a complete acceptance verdict could be established.";
    for (const surface of PROMPT_SURFACES) {
      const reviewer = normalize(renderedOf(surface, "implement-reviewer"));
      expect(reviewer).toContain(
        "`gateCompleteBy`, `responseStoreNow`, and `synthesisStoreReserveMs`",
      );
      expect(reviewer).toContain("Never derive a new phase window");
      expect(reviewer).toContain("only `now >= gateCompleteBy` exhausts the phase");
      expect(reviewer).toContain("--deadline <gateCompleteBy> -- bun run check");
      expect(reviewer).toContain(exhaustion);
      expect(reviewer).toContain("`phase-budget-exhausted-before-result-commit-verification`");
      expect(reviewer).toContain("`phase-budget-exhausted-before-gate-start`");
      expect(reviewer).toContain("measured elapsed time through termination and settlement");

      const advance = normalize(renderedOf(surface, "implement/advance"));
      expect(advance).toContain(
        "Omit `responseStoreNow`, `gateCompleteBy`, and `synthesisStoreReserveMs`",
      );
      if (surface === "pi") {
        expect(advance).toContain("the authoritative dispatch lifecycle binds those");
      } else {
        expect(advance).toContain("`prepare_dispatch` binds those absolute values");
      }
    }
  });

  it("T1697 limits Codex explorer shell access to static repository inspection", () => {
    for (const role of EXPLORER_ROLES) {
      const rendered = normalize(renderedOf("codex", role));
      expect(rendered).toContain(
        "Only when the harness exposes no dedicated filesystem read or search tools may you use shell commands for static repository inspection.",
      );
      expect(rendered).toContain(
        "Repository metadata and locating or displaying existing files are the only permitted shell purposes.",
      );
      expect(rendered).toContain(
        "Limit shell use to non-mutating invocations of `git status`, `git log`, `git show`, `git diff`, `git grep`, `git ls-files`, `git rev-parse`, `pwd`, `ls`, `find`, `fd`, `rg`, `grep`, `sed -n`, `head`, `tail`, `cat`, `stat`, `file`, and `wc`.",
      );
      expect(rendered).toContain(
        "Do not use redirection, command substitution, `find -delete`, `find -exec`, or any option with a write side effect.",
      );
      expect(rendered).toContain(
        "Mutation, tests, builds, benchmarks, package execution, shell networking, adjudication, and child dispatch remain prohibited.",
      );
      expect(rendered).toContain(
        "Dynamic evidence requires the corresponding prober or experimenter.",
      );
    }
  });

  it("T1697 keeps Claude and Pi explorer shell restrictions", () => {
    for (const surface of ["claude", "pi"] as const) {
      for (const role of EXPLORER_ROLES) {
        const rendered = normalize(renderedOf(surface, role));
        expect(rendered).toContain(
          "Use the harness's dedicated filesystem read and search tools for static repository inspection; shell commands remain prohibited.",
        );
        expect(rendered).toContain(
          "Mutation, tests, builds, benchmarks, package execution, shell networking, adjudication, and child dispatch remain prohibited.",
        );
      }
    }
  });

  it("T1697 routes dynamic evidence to the corresponding execution role", () => {
    for (const surface of PROMPT_SURFACES) {
      expect(normalize(renderedOf(surface, "investigate-explorer"))).toContain(
        "request an exact probe from the investigate-prober",
      );
      expect(normalize(renderedOf(surface, "research-explorer"))).toContain(
        "request an exact experiment from the research-experimenter",
      );
    }
  });

  // ── CHECK 3 — the structured input survives the render, per surface ─────
  for (const surface of PROMPT_SURFACES) {
    it(`${surface}: every dispatch edge survives rendering`, () => {
      for (const edge of DISPATCH_EDGE_INPUTS) {
        const body = normalize(renderedOf(surface, edge.flowRoleId));
        expect(body).toContain(edge.role);
        const refsOnlyWorker = surface !== "pi" && edge.role === "implement-worker";
        if (edge.role === "implement-worker") {
          if (refsOnlyWorker) {
            expect(body).toContain(normalize(T977_WORKER_REFS));
          } else {
            expect(body).not.toContain(normalize(T977_WORKER_REFS));
            expect(body).toContain("headline");
            expect(body).toContain("acceptance");
            expect(body).toContain("worktreePath");
          }
        }
      }
    });
  }

  it("T1491 sends the complete private Codex boundary request on every parent edge", () => {
    for (const edge of DISPATCH_EDGE_INPUTS) {
      const body = normalize(renderedOf("codex", edge.flowRoleId));
      for (const field of [
        "roleId",
        "handle:{attestationId,generation}",
        "inputCapability",
        "resultCapability",
        "cwd",
        "ledgerCwd",
        "model",
        "reasoningEffort",
        "sandboxMode",
        "timeoutMs",
      ] as const) {
        expect(body).toContain(field);
      }
      expect(body).toContain("stdin");
      expect(body).toContain("parent project");
      expect(body).toContain("child execution worktree");
      expect(body).toContain("capabilities off");
      expect(body).toContain("argv");
      expect(body).not.toContain("{ attestationId, generation, inputCapability }");
    }
  });

  it("T2045 binds each Codex Git role to its sole broker operation and receipt family", () => {
    const dispatch = readFileSync(
      path.join(ASSETS_ROOT, "fragments", "codex", "subagent-dispatch.md"),
      "utf8",
    );
    expect(dispatch).toContain("gitChangeCapability?");
    expect(dispatch).toContain("gitConflictCapability?");

    const worker = renderedOf("codex", "implement-worker");
    expect(worker).toContain("gitChangeCapability");
    expect(worker).toContain("git_commit");
    expect(worker).toContain("gitReceipts");
    expect(worker).not.toContain("gitConflictCapability");
    expect(worker).not.toContain("git_resolve_continue");

    const resolver = renderedOf("codex", "implement-conflict-resolver");
    expect(resolver).toContain("gitConflictCapability");
    expect(resolver).toContain("git_resolve_continue");
    expect(resolver).toContain("conflictReceipts");
    expect(resolver).not.toContain("gitChangeCapability");
    expect(resolver).not.toContain("git_commit");
  });

  it("T1492 gives every dispatched Codex role one complete result-delivery contract", () => {
    expect(DISPATCHED_ROLES.map(({ roleId }) => roleId)).toHaveLength(9);
    for (const { roleId } of DISPATCHED_ROLES) {
      const body = normalize(renderedOf("codex", roleId));
      expect(countOccurrences(body, "fetch_dispatch_input")).toBe(1);
      expect(body).toContain("exactly once");
      expect(body).toContain("store_result");
      expect(body).toContain("result-stored");
      expect(body).toContain("prepared dispatch handle only");
      expect(body).not.toContain("final fenced");
      expect(body).not.toContain("final reply content");
      expect(body).not.toContain("writes nothing");
      expect(body).not.toContain("write nothing");
    }
  });

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
    expect(projection).not.toContain("before dispatching it through the collaboration transport");

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
      pi: 'dispatch_agent(agent: "<role>", task: "<complete prompt>", targetRef: "<canonical-ref>")',
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
