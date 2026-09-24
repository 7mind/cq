/**
 * defects:D399 — the Pi extension never completes the ref-first lifecycle.
 *
 * The packaged Pi PARENT contract (`fragments/pi/subagent-dispatch.md`) has the
 * parent call `prepare_dispatch` and then launch
 * `dispatch_agent(agent, task: "<dispatch-handle>", targetRef)`, where `task`
 * carries the OPAQUE handle and nothing else. The extension is meant to resolve
 * the prepare-bound typed input, inject it at the child boundary, and store the
 * child's structured result against the prepared result capability.
 *
 * It does none of that: `args.task` becomes the child's prompt verbatim and the
 * child's final text is returned as the tool body, so a prepared attestation
 * stays prepared and is truthfully aborted missing-result. That is what
 * happened to att_SCZmv73EK4sACsg4HVQy4itOcJPT6Juv and
 * att_47N5ElOspr_-0A-Fp1NHn-BNoDbpMpOQ on goals:G183.
 *
 * `nix/pkg/pi-extensions` is OUTSIDE the `bun run check` workspace root, so the
 * executable reproduction there is not reached by the gate. This is §6a form
 * (b): spawn it and assert its non-zero exit and its diagnostic, which keeps
 * the expected failure inside a green full gate. When D399 is fixed the
 * subprocess turns green and THIS test fails, forcing it to be retired with the
 * defect rather than outliving it.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", "..", "..");
const PI_EXTENSIONS_ROOT = path.join(REPO_ROOT, "nix", "pkg", "pi-extensions");
const REPRODUCTION = "cq-subagent-ref-first.test.ts";
/** The opaque handle the reproduction hands to `dispatch_agent`. */
const DISPATCH_HANDLE = "att_D399ReproHandle000000000000000000000000";

describe("D399 Pi ref-first dispatch reproduction [Behavioral-Active Blackbox]", () => {
  test("the extension still forwards the opaque handle to the child as its prompt", () => {
    const reproduction = path.join(PI_EXTENSIONS_ROOT, REPRODUCTION);
    // An ENOENT here would pass a naive non-zero-exit assertion, so the file's
    // presence is checked separately from its outcome.
    expect(existsSync(reproduction)).toBe(true);

    const run = spawnSync("bun", ["test", REPRODUCTION], {
      cwd: PI_EXTENSIONS_ROOT,
      encoding: "utf8",
      timeout: 180_000,
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;

    expect(run.error).toBeUndefined();
    expect(run.status).not.toBe(0);
    // Fail for the RIGHT reason: the handle reached the child's argv. A crash,
    // a missing fixture or an unrelated assertion would not print this.
    expect(output).toContain("Expected to not contain:");
    expect(output).toContain(DISPATCH_HANDLE);
    expect(output).toContain("--append-system-prompt");
  }, 240_000);
});
