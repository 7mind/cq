/**
 * defects:D399 and defects:D402 — a dispatch contract must describe a lifecycle
 * that SETTLES. Their history is kept below; since G224 the settling component
 * is CQ itself, and the guards pin that contract on every surface.
 *
 * defects:D399 — the Pi parent contract must describe a lifecycle that settles.
 *
 * The packaged Pi contract used to be internally inconsistent. The PARENT
 * fragment had the parent call `prepare_dispatch` and then hand `dispatch_agent`
 * an opaque handle; the CHILD fragment had the child return its structured
 * result as fenced JSON; and nothing anywhere stored that result. Two Pi
 * planners duly produced schema-valid candidate bodies and trusted completion
 * truthfully aborted att_SCZmv73EK4sACsg4HVQy4itOcJPT6Juv and
 * att_47N5ElOspr_-0A-Fp1NHn-BNoDbpMpOQ as missing-result.
 *
 * The handle-passing half could never have worked. researches:RS15 established
 * why from the record's own shape: `DispatchPrepared` persists
 * `inputCapabilityHash`/`resultCapabilityHash` and states twice that "The token
 * itself is never stored", so a capability exists exactly once — in the return
 * of `prepare_dispatch` — and the extension can never obtain one from a handle.
 * Preparation and settlement must live in the SAME component, and on this
 * surface that component is the parent.
 *
 * This guard pins the repaired contract against the two ways it can regress:
 * losing the settlement step, or reinstating the handle-in-`task` call that
 * cannot be implemented.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "cq-assets");

function fragment(surface: string, name: string): string {
  return readFileSync(path.join(ASSETS_ROOT, "fragments", surface, `${name}.md`), "utf8");
}

/** A role's own input-delivery fragment; these are per-role, not per-surface. */
function roleFragment(surface: string, roleId: string, name: string): string {
  return readFileSync(
    path.join(ASSETS_ROOT, "fragments", surface, "agents", roleId, `${name}.md`),
    "utf8",
  );
}

/** Blockquote markers and wrapping erased, so a phrase assertion is not a line-break assertion. */
function prose(body: string): string {
  return body.replace(/^>\s?/gmu, "").replace(/\s+/gu, " ").trim();
}

/**
 * G224 — the lesson of D399/D402 carried into CQ-driven dispatch: preparation
 * and settlement must live in ONE component, because a capability exists only
 * in prepare's return. That component is now CQ itself. The parent starts and
 * fetches; CQ prepares, launches the target harness's process boundary, and
 * settles; and each surface's CHILD contract must match how CQ settles it.
 */
const SURFACES = ["claude", "codex", "pi"] as const;
const HOST_LAUNCH_REFUSAL: Readonly<Record<(typeof SURFACES)[number], string>> = {
  claude: "Never launch a CQ role with the native `Agent` tool",
  codex: "Never run `cq-codex-role` or the native `spawn_agent` transport yourself",
  pi: "Never launch a CQ role with `dispatch_agent`",
};
const RETIRED_PARENT_LIFECYCLE = [
  "prepare_dispatch",
  "store_result",
  "confirm_dispatch_completion",
  "abort_dispatch",
  "fetch_dispatch_input",
] as const;

describe("G224 CQ-driven parent dispatch contract", () => {
  for (const surface of SURFACES) {
    const parent = fragment(surface, "subagent-dispatch");

    test(`${surface}: the parent starts through CQ, then fetches with a bounded wait`, () => {
      const step = (needle: string): number => parent.indexOf(needle);
      expect(parent).toContain("CQ_SUBAGENT");
      expect(step("start_dispatch")).toBeGreaterThanOrEqual(0);
      expect(step("fetch_dispatch_result")).toBeGreaterThan(step("start_dispatch"));
      expect(prose(parent)).toContain("`waitMs` (at most 45000)");
      expect(prose(parent)).toContain("`consumed` fetch carries the validated `output` exactly once");
    });

    test(`${surface}: the parent never runs the settlement it no longer owns`, () => {
      for (const tool of RETIRED_PARENT_LIFECYCLE) expect(parent, tool).not.toContain(tool);
      expect(prose(parent)).toContain("never holds or relays a dispatch capability");
    });

    test(`${surface}: the parent is told not to launch with its host tool`, () => {
      // defects:D534 required naming a concrete host call; the call named now is
      // the one the parent must NOT make for a CQ role.
      expect(prose(parent)).toContain(HOST_LAUNCH_REFUSAL[surface]);
    });

    test(`${surface}: the implement workflow starts through CQ and fetches`, () => {
      const workflow = fragment(surface, "implement-dispatch-workflow");
      for (const tool of ["prepare_dispatch", "confirm_dispatch_completion"]) {
        expect(workflow, tool).not.toContain(tool);
      }
      expect(workflow).toContain("start_dispatch");
      expect(workflow).toContain("fetch_dispatch_result");
    });
  }
});

describe("G224 child contracts match how CQ settles each surface", () => {
  test("a Claude child stores through its own bound server and replies with the handle only", () => {
    // The print bridge settles by confirming a stored result whose child final
    // message is the handle; a fenced body here would leave it missing-result.
    const child = prose(fragment("claude", "dispatch-result-delivery"));
    expect(child).toContain("call the ledger MCP `fetch_dispatch_input` tool exactly once");
    expect(child).toContain("call `store_result` exactly once");
    expect(child).toContain("omit `resultCapability`");
    expect(child).toContain("Reply with the dispatch handle only");
    expect(child).not.toContain("fenced `json` block");
  });

  test("a Claude resolver continues through its bound git-conflict capability", () => {
    const input = prose(roleFragment("claude", "implement-conflict-resolver", "dispatch-input-delivery"));
    expect(input).toContain("without `gitConflictCapability`");
    expect(input).not.toContain("the resolver-only `gitConflictCapability` returned by prepare");
  });

  test("a server-settled Pi child returns a fenced result and never holds a capability; CQ stores it", () => {
    // D399 still holds for server-settled Pi roles: the child has no ledger
    // connection, so the settling component (now CQ) reads this block.
    const child = fragment("pi", "dispatch-result-delivery");
    expect(child).toContain("fenced `json` block");
    expect(child).not.toContain("store_result");
  });

  test("a child-stored Pi implementation role retrieves and stores through its CQ-bound connection (D544)", () => {
    for (const roleId of ["implement-worker", "implement-reviewer", "implementation-auditor", "implement-conflict-resolver"]) {
      const roleInput = prose(roleFragment("pi", roleId, "dispatch-input-delivery"));
      expect(roleInput, roleId).toContain("`fetch_dispatch_input` tool exactly once");
      expect(roleInput, roleId).toContain("`store_result` without `resultCapability`");
      expect(roleInput, roleId).not.toContain("held protocol");
    }
    expect(prose(roleFragment("pi", "implement-conflict-resolver", "dispatch-input-delivery"))).toContain(
      "`git_resolve_continue` without `gitConflictCapability`",
    );
  });

  test("a Codex child keeps storing at its role boundary", () => {
    const child = prose(fragment("codex", "dispatch-result-delivery"));
    expect(child).toContain("call `store_result` exactly once");
    expect(child).toContain("`resultCapability`");
  });
});
