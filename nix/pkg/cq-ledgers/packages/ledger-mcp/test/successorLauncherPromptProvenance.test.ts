/**
 * defects:D538 — the successor launcher must enforce the attested prompt digest.
 *
 * `createImplementationSuccessorLauncher` is the ONE place CQ launches a child
 * in production, and it carries parentGateCapability and gitChangeCapability.
 * It passes `CQ_PROMPT_ROOT` and lets the child resolve its own role text, so
 * nothing compares that text against `prepared.promptProvenance.promptDigest`
 * — the digest of the exact instructions the dispatch was prepared against.
 *
 * The qualified transport adapter performs precisely that comparison, but
 * defects:D535 leaves it with no production consumer, so the check exists and
 * never runs while the launcher that does run omits it.
 *
 * A drifted prompt root therefore launches a capability-bearing successor
 * whose attestation asserts a provenance the running child does not have.
 */
import { describe, expect, test } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DispatchPrepared } from "@cq/config";
import { createImplementationSuccessorLauncher } from "../src/main.js";
import { cohortGitBrokerFixture } from "../../ledger/test/workCohortGitBrokerFixture.js";

/** A digest no role prompt can hash to; the adapter would refuse on it. */
const IMPOSSIBLE_PROMPT_DIGEST = "f".repeat(64);

describe("D538 successor launcher prompt provenance [Behavioral-Active Blackbox]", () => {
  test("refuses a launch whose role instructions cannot hash to the attested digest", async () => {
    const subject = await cohortGitBrokerFixture("memory");
    try {
      const script = join(subject.root, "record-successor.ts");
      const captured = join(subject.root, "successor.json");
      await writeFile(
        script,
        `const invocation = JSON.parse(await Bun.stdin.text());\n` +
          `await Bun.write(${JSON.stringify(captured)}, JSON.stringify({ invocation }));\n` +
          `console.log(JSON.stringify(invocation.handle));\n`,
      );
      const prepared: DispatchPrepared = {
        attestationId: "d538-provenance",
        generation: 2,
        promptProvenance: {
          roleId: "implement-worker",
          version: 13,
          surface: "codex",
          promptDigest: IMPOSSIBLE_PROMPT_DIGEST,
          catalogHash: "b".repeat(64),
          inputDigest: "c".repeat(64),
        },
        inputCapability: { scope: "fetch-input", token: "cq_input_d538" },
        resultCapability: { scope: "store-result", token: "cq_result_d538" },
        parentGateCapability: { scope: "parent-gate", token: "cq_parent_d538" },
        gitChangeCapability: { scope: "git-change", token: "cq_git_d538" },
        responseStoreNow: "2099-01-01T00:00:00.000Z",
        childCancelAt: "2099-01-01T00:01:00.000Z",
        launchDeadline: "2099-01-01T00:02:00.000Z",
      };
      const launch = createImplementationSuccessorLauncher(
        {
          roleCommand: process.execPath,
          roleScript: script,
          ledgerCommand: "/recording/cq",
          codexExecutable: "/recording/codex",
          model: "recording",
          reasoningEffort: "medium",
          sandboxMode: "workspace-write",
        },
        subject.root,
        {},
      );

      await expect(
        launch({
          prepared,
          managed: subject.authorization,
          expectedChild: { childId: "implement-worker#d538", runId: "d538-run" },
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/prompt digest/i);

      // And it must refuse BEFORE spawning, not after: no child wrote its
      // capture file, so no capability-bearing process ever started.
      await expect(readFile(captured, "utf8")).rejects.toThrow();
    } finally {
      await subject.close();
    }
  }, 60_000);
});
