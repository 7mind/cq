import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  // D580: a gitignored scratch source never reaches a managed worktree, so it
  // must not turn the local closure red.
  test(
    "ignores gitignored scratch sources",
    async () => {
      const directory = join(REPOSITORY_ROOT, "nix/pkg/cq-ledgers/debug");
      const scratch = join(directory, `d580-${process.pid}-${Date.now()}.ts`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(scratch, 'import { spawn } from "node:child_process";\nspawn("true");\n');
      try {
        const resolution = await resolveManagedGateClosure(REPOSITORY_ROOT);
        expect(resolution.status === "resolved" ? "resolved" : `${resolution.reason}: ${resolution.detail}`).toBe("resolved");
      } finally {
        rmSync(scratch, { force: true });
      }
    },
    120_000,
  );
});
