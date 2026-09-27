import { describe, expect, test } from "bun:test";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";
import { cohortReviewerRoleFor } from "../src/workCohortCompletionRuntime.js";

function reviewerStore(surface: "claude" | "codex", promptDigest: string): PromptArtifactStore {
  const metadata = {
    roleId: "implement-reviewer",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-reviewer.md",
    sidecarSchemaRoleId: "implement-reviewer",
    promptSurface: surface,
    promptDigest,
    schemaVersion: 9,
    schemaDigest: "e".repeat(64),
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: surface,
      catalogHash: "c".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  } as unknown as PromptArtifactStore;
}

// D597: the configured panel runs one reviewer on Claude and one on Codex. The
// completion runtime authenticated every review against the parent's own
// (Claude) reviewer contract, so the Codex review of T2929 was refused with
// "cohort review lacks exact installed role and consumed native result bindings".
describe("D597 cohort reviewer contract follows the review's surface", () => {
  const claude = reviewerStore("claude", "a".repeat(64));
  const codex = reviewerStore("codex", "b".repeat(64));

  test("a review on the parent's surface uses the parent's installed contract [BA]", () => {
    expect(cohortReviewerRoleFor("claude", claude, { codex })).toMatchObject({
      surface: "claude",
      promptDigest: "a".repeat(64),
    });
  });

  test("a review on another surface uses that surface's installed contract [BA]", () => {
    expect(cohortReviewerRoleFor("codex", claude, { claude, codex })).toMatchObject({
      surface: "codex",
      promptDigest: "b".repeat(64),
    });
  });

  test("a surface with no installed contract is refused explicitly [BA]", () => {
    expect(() => cohortReviewerRoleFor("pi", claude, { codex })).toThrow(
      "no installed reviewer contract",
    );
  });
});
