/**
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

describe("D399 Pi ref-first dispatch contract", () => {
  const parent = fragment("pi", "subagent-dispatch");

  test("the parent is told to store the child's result", () => {
    // The missing step. Without it a prepared attestation stays prepared and
    // trusted completion aborts it missing-result, which is the defect.
    expect(parent).toContain("store_result");
    // And to submit what the child returned rather than a paraphrase of it.
    expect(parent).toContain("verbatim");
  });

  test("the parent settles in order: prepare, materialize, dispatch, store, fetch", () => {
    const step = (needle: string): number => parent.indexOf(needle);
    expect(step("prepare_dispatch")).toBeGreaterThanOrEqual(0);
    expect(step("fetch_dispatch_input")).toBeGreaterThan(step("prepare_dispatch"));
    expect(step("dispatch_agent(")).toBeGreaterThan(step("fetch_dispatch_input"));
    expect(step("store_result")).toBeGreaterThan(step("dispatch_agent("));
    expect(step("fetch_dispatch_result")).toBeGreaterThan(step("store_result"));
  });

  test("`task` carries the typed input, never a handle or a capability", () => {
    // RS15: a capability cannot reach the extension, so a handle-addressed
    // dispatch is unimplementable. Reinstating it would silently restore the
    // defect, since the extension forwards `task` to the child verbatim.
    expect(prose(parent)).toContain('task: "<materialized typed input>"');
    expect(prose(parent)).not.toContain("<dispatch-handle>");
    expect(prose(parent)).toContain("never a capability");
  });

  test("the child contract still expects a fenced structured result", () => {
    // The parent's step 4 reads that block. If the child stopped producing one
    // there would be nothing to store, so the two halves are pinned together.
    const child = fragment("pi", "dispatch-result-delivery");
    expect(child).toContain("fenced `json` block");
    expect(child).toContain("supplied by the extension");
  });

  test("the child is never told to hold a capability on this surface", () => {
    // assets.nix forbids `store_result` in the Pi child fragment, and the
    // parent-owned lifecycle is what makes that restriction coherent rather
    // than a dead end.
    expect(fragment("pi", "dispatch-result-delivery")).not.toContain("store_result");
    const roleInput = roleFragment("pi", "implement-worker", "dispatch-input-delivery");
    expect(roleInput).not.toContain("inputCapability");
    expect(roleInput).not.toContain("fetch_dispatch_input");
  });
});
