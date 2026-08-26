import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { resolveManagedGateClosure } from "../src/index.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

describe("repository gate closure", () => {
  // regression: D363 — stale declarations made every managed worktree unpreparable.
  test(
    "current repository bytes satisfy the checked-in closure manifest",
    async () => {
      const resolution = await resolveManagedGateClosure(REPOSITORY_ROOT);
      if (resolution.status !== "resolved") {
        throw new Error(
          `repository gate closure is ${resolution.reason}: ${resolution.detail}`,
        );
      }

      expect(resolution.status).toBe("resolved");
    },
    120_000,
  );
});
