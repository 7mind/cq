import { describe, expect, test } from "bun:test";
import { exposedLedgerToolsForRole } from "@cq/config";
import { LEDGER_TOOL_NAMES, prefixedToolNames } from "@cq/ledger";
import { buildServerInstructions } from "../src/main.js";

/**
 * Byte-identity fixture: the ORIGINAL SERVER_INSTRUCTIONS body, verbatim, kept
 * here so the empty-prefix invariant is asserted against an INDEPENDENT copy of
 * the text (not against `buildServerInstructions` itself). Any prose drift in
 * the source must be mirrored here on purpose, or this test fails — which is the
 * point: `buildServerInstructions('')` MUST stay byte-identical to this text.
 */
const ORIGINAL_SERVER_INSTRUCTIONS = [
  "Markdown-backed typed ledgers. Milestones form dependency DAGs; other items attach to milestones. Discover schemas with enumerate_ledgers. Write schema-valid items with author/session provenance; recognized ledger references are canonicalized on write.",
  "",
  "Reads require compact or full projection. Paginate fetch_ledger until nextOffset is null. fts_search spans active ledgers by default and accepts field qualifiers; terminal items remain active until archive_milestone sweeps a fully terminal milestone.",
  "",
  "Use snapshot and derive_predicates for CQ flow state. Dispatch and plan-lifecycle tools retain their capability, generation, fence, recovery, and idempotency contracts; preserve exact identifiers returned by those tools.",
].join("\n");

describe("buildServerInstructions", () => {
  test("empty prefix is byte-identical to the original SERVER_INSTRUCTIONS text", () => {
    expect(buildServerInstructions("")).toBe(ORIGINAL_SERVER_INSTRUCTIONS);
  });

  test("prefixed output names tools in their prefixed form", () => {
    const text = buildServerInstructions("myproj");
    expect(text).toContain("myproj_enumerate_ledgers");
    expect(text).toContain("myproj_snapshot");
  });

  test("prefixed output contains no bare whole-word tool token", () => {
    const text = buildServerInstructions("myproj");
    for (const name of LEDGER_TOOL_NAMES) {
      // A bare whole-word occurrence of `name` NOT preceded by `myproj_`.
      const bare = new RegExp(`(?<!myproj_)\\b${name}\\b`);
      expect(bare.test(text)).toBe(false);
    }
  });

  test("every prefixed name it emits comes from prefixedToolNames (helper reuse)", () => {
    const text = buildServerInstructions("myproj");
    const emitted = text.match(/myproj_[a-z_]+/g) ?? [];
    expect(emitted.length).toBeGreaterThan(0);
    const allowed = new Set(prefixedToolNames("myproj"));
    // prefixedToolNames produces exactly one entry per LEDGER_TOOL_NAMES member.
    expect(allowed.size).toBe(LEDGER_TOOL_NAMES.length);
    // Pin the total registered tool count so any accidental addition/removal fails here.
    expect(LEDGER_TOOL_NAMES.length).toBe(29);
    for (const tok of emitted) {
      expect(allowed.has(tok)).toBe(true);
    }
  });

  test("narrow role instructions retain the concise operational contract", () => {
    const roleId = "implement-worker";
    const available = new Set(exposedLedgerToolsForRole(roleId));
    const text = buildServerInstructions("worker", roleId);
    expect(available).toEqual(new Set(["fetch_dispatch_input", "store_result"]));
    expect(text).toBe(ORIGINAL_SERVER_INSTRUCTIONS);
  });

  test("unknown role instructions fail closed", () => {
    expect(() => buildServerInstructions("", "unknown-profile")).toThrow(
      'unknown role tool profile "unknown-profile"',
    );
  });
});
