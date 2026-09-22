import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProcessWorksetEffectAdmissionProvider } from "@cq/process-control";
import { assertCodexBoundaryEffectTargetRef } from "../src/codexRoleBoundary.js";

export function investigationNativeBindingFixture() {
  return { kind: "cq-investigation-cohort-launch" as const, version: 1 as const,
    handle: { attestationId: "investigation-native", generation: 1 },
    roleId: "investigate-explorer" as const, memberRef: "defects:D1",
    planDigest: "a".repeat(64), preparedDigest: "b".repeat(64), executionEpoch: "epoch-native",
    members: [1, 2].map((id) => ({ defectRef: `defects:D${id}`, defectRevision: `${id}`.repeat(64),
      hypothesisRef: `hypothesis:H${id}`, hypothesisRevision: `${id + 2}`.repeat(64) })),
    expectedChild: { childId: "investigate-explorer#native", runId: "native-run" } };
}

describe("investigation native launch identity [Behavioral-Active Blackbox-GoodCommunication]", () => {
  test("Codex admits the exact investigation plan target without an implementation or task anchor", () => {
    const binding = investigationNativeBindingFixture();
    const target = `cq-cohort-effect:v1:${binding.planDigest}`;
    expect(assertCodexBoundaryEffectTargetRef(target, undefined, binding)).toBe(target);
    expect(() => assertCodexBoundaryEffectTargetRef("defects:D1", undefined, binding)).toThrow();
  });

  test("process proxy forwards exact investigation metadata without a private lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-investigation-provider-wire-"));
    try {
      const transcript = join(directory, "transcript.jsonl");
      const binding = investigationNativeBindingFixture();
      const targetRef = `cq-cohort-effect:v1:${binding.planDigest}`;
      const provider = createProcessWorksetEffectAdmissionProvider({ command: process.execPath,
        args: [fileURLToPath(new URL("../../process-control/test/processWorksetEffectAdmissionProviderFixture.ts", import.meta.url))],
        cwd: directory, env: { ...process.env, CQ_TEST_PROVIDER_TRANSCRIPT: transcript }, investigationCohort: binding });
      const admission = await provider.acquire({ kind: "child-dispatch", targetRef });
      await admission.abandonBeforeRegistration();
      expect((await readFile(transcript, "utf8")).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        { op: "acquire", kind: "child-dispatch", targetRef, investigationCohort: binding }, { op: "abandon" },
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
