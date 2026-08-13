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
  "Typed milestone DAG; items attach. enumerate_ledgers: schemas. Writes: valid fields, author/session, recognized refs canonicalized.",
  "",
  "Projection compact|complement|full; compact.fields ⊎ complement.fields = full.fields. fetch_ledger: paginate until nextOffset=null. fts_search: active by default with field qualifiers; terminal items stay active until archive_milestone sweeps a fully terminal milestone.",
  "",
  "Before planning/implementation, fts_search relevant active memories with ledger/status filters; fetch_item full matches as needed. Write only confirmed durable project facts: create_item in memories under M-AMBIENT with author/session and useful sourceRefs. Exclude transient reasoning, session notes, and unconfirmed preferences.",
  "",
  "snapshot/derive_predicates: CQ state. Preserve IDs and dispatch/plan capability/generation/fence/recovery/idempotency.",
].join("\n");

describe("buildServerInstructions", () => {
  test("empty prefix is byte-identical to the original SERVER_INSTRUCTIONS text", () => {
    expect(buildServerInstructions("")).toBe(ORIGINAL_SERVER_INSTRUCTIONS);
  });

  test("prefixed output names tools in their prefixed form", () => {
    const text = buildServerInstructions("myproj");
    expect(text).toContain("myproj_enumerate_ledgers");
    expect(text).toContain("myproj_fts_search relevant active memories");
    expect(text).toContain("myproj_fetch_item full matches");
    expect(text).toContain("myproj_create_item in memories");
    expect(text).toContain("myproj_snapshot");
  });

  test("canonical memory policy is explicit on the unprefixed surface", () => {
    const text = buildServerInstructions("");
    expect(text).toContain(
      "Before planning/implementation, fts_search relevant active memories with ledger/status filters; fetch_item full matches as needed.",
    );
    expect(text).toContain(
      "Write only confirmed durable project facts: create_item in memories under M-AMBIENT with author/session and useful sourceRefs.",
    );
    expect(text).toContain(
      "Exclude transient reasoning, session notes, and unconfirmed preferences.",
    );
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
    expect(LEDGER_TOOL_NAMES.length).toBe(39);
    for (const tok of emitted) {
      expect(allowed.has(tok)).toBe(true);
    }
  });

  test("narrow role instructions name only available tools, with or without a prefix", () => {
    const roleId = "implement-worker";
    const available = new Set(exposedLedgerToolsForRole(roleId));
    expect(available).toEqual(new Set(["fetch_dispatch_input", "store_result", "git_commit"]));
    expect(buildServerInstructions("", roleId)).toBe(
      [
        'Ledger tool profile "implement-worker" exposes only:',
        "- fetch_dispatch_input",
        "- store_result",
        "- git_commit",
      ].join("\n"),
    );
    expect(buildServerInstructions("worker", roleId)).toBe(
      [
        'Ledger tool profile "implement-worker" exposes only:',
        "- worker_fetch_dispatch_input",
        "- worker_store_result",
        "- worker_git_commit",
      ].join("\n"),
    );
  });

  test("an empty profile emits no unavailable tool name", () => {
    expect(exposedLedgerToolsForRole("plan-review")).toEqual([]);
    const text = buildServerInstructions("", "plan-review");
    expect(text).toBe('Ledger tool profile "plan-review" exposes no tools.');
    for (const name of LEDGER_TOOL_NAMES) {
      expect(new RegExp(`\\b${name}\\b`).test(text)).toBe(false);
    }
  });

  test("unknown role instructions fail closed", () => {
    expect(() => buildServerInstructions("", "unknown-profile")).toThrow(
      'unknown role tool profile "unknown-profile"',
    );
  });
});
