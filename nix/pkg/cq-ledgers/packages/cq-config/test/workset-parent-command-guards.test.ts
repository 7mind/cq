import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const COMMAND_ROOT = join(REPOSITORY_ROOT, "nix", "pkg", "cq-assets", "commands", "cq");
const GUARDED_COMMANDS = [
  "advance.md",
  "begin.md",
  "plan.md",
  "plan/advance.md",
  "plan/follow-up.md",
  "investigate.md",
  "investigate/advance.md",
  "research.md",
  "research/advance.md",
] as const;

describe("T1986 parent command workset guards [Behavioral-Active Blackbox-Atomic]", () => {
  test("every effectful parent command binds the shared workset discipline", () => {
    for (const command of GUARDED_COMMANDS) {
      const source = readFileSync(join(COMMAND_ROOT, command), "utf8");
      expect(source, command).toContain("{{cq:fragment:workset-effect-discipline}}");
    }
  });
});
