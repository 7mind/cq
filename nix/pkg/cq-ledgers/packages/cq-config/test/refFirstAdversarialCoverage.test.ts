/**
 * T704 / G94 — adversarial ref-first adherence coverage pin.
 * The deterministic cases live in the T689/T692/T694 enforcement suites.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir);
const SUITES = {
  claude: readFileSync(path.join(ROOT, "claudeRefFirstEnforcement.test.ts"), "utf8"),
  codex: readFileSync(path.join(ROOT, "codexRefFirstEnforcement.test.ts"), "utf8"),
  pi: readFileSync(path.join(ROOT, "piRefFirstDispatch.test.ts"), "utf8"),
} as const;

const REQUIRED: readonly { readonly needle: string; readonly suites: readonly (keyof typeof SUITES)[] }[] = [
  { needle: "stolen", suites: ["claude"] },
  { needle: "unauthorized", suites: ["codex"] },
  { needle: "stale", suites: ["codex"] },
  { needle: "expiry", suites: ["claude"] },
  { needle: "echo", suites: ["claude", "codex"] },
  { needle: "invalid-output", suites: ["claude", "codex"] },
  { needle: "generation", suites: ["claude", "codex"] },
  { needle: "cancel", suites: ["claude", "codex"] },
  { needle: "capability", suites: ["claude", "codex", "pi"] },
  { needle: "fetch", suites: ["claude", "codex"] },
];

describe("T704 adversarial ref-first coverage", () => {
  for (const requirement of REQUIRED) {
    test(`required case "${requirement.needle}" remains in ${requirement.suites.join("/")} [BA]`, () => {
      for (const suite of requirement.suites) {
        expect(SUITES[suite].toLowerCase()).toContain(requirement.needle);
      }
    });
  }

  test("no suite instructs logging a capability token or output body [BA]", () => {
    for (const [name, body] of Object.entries(SUITES)) {
      expect(body, name).not.toMatch(/cq_result_[A-Za-z0-9_-]{20,}/);
      expect(body, name).not.toContain("promptTemplate");
    }
  });
});
