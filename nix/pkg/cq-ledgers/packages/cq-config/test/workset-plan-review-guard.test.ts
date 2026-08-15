import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exposedLedgerToolsForRole } from "../src/index.js";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const ASSETS_ROOT = join(REPOSITORY_ROOT, "nix", "pkg", "cq-assets");

describe("T1986 plan-review workset boundary", () => {
  test("D331 keeps every dispatched reviewer write-free and leaves persistence to the parent", () => {
    const portable = readFileSync(join(ASSETS_ROOT, "commands", "cq", "plan-review.md"), "utf8");
    const advance = readFileSync(
      join(ASSETS_ROOT, "commands", "cq", "plan", "advance.md"),
      "utf8",
    );
    const dispatched = readFileSync(join(ASSETS_ROOT, "agents", "plan-reviewer.md"), "utf8");
    const readme = readFileSync(join(ASSETS_ROOT, "README.md"), "utf8");
    const flowStateMachines = readFileSync(
      join(ASSETS_ROOT, "docs", "flow-state-machines.md"),
      "utf8",
    );
    const normalizedFlowStateMachines = flowStateMachines.replace(/\s+/g, " ");

    expect(exposedLedgerToolsForRole("plan-review")).toEqual([]);
    expect(portable).toContain("Write nothing");
    expect(exposedLedgerToolsForRole("plan-reviewer")).toEqual([
      "fetch_item",
      "fts_search",
      "list_milestone_items",
      "fetch_dispatch_input",
      "store_result",
    ]);
    expect(dispatched).toContain("Do not create a review item; return the identical structured verdict");
    expect(dispatched).toContain(
      "The parent owns review\npersistence in both configured-panel and unconfigured fallback modes",
    );
    expect(dispatched).not.toContain("create_item");
    expect(advance).toContain(
      "The reviewer returns a structured verdict and writes nothing. The parent writes exactly one review",
    );
    expect(advance).toContain("Write exactly one aggregated review linked to the goal");
    expect(readme).toContain("the adversarial reviewer (write-free; parent persists)");
    expect(normalizedFlowStateMachines).toContain(
      "The parent writes the sole `reviews` item for both the single-reviewer fallback and configured panel",
    );
    expect(flowStateMachines).not.toContain("the native subagent writes the ledger");
    expect(dispatched).not.toContain("management-token");
  });
});
