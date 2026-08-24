import { describe, expect, test } from "bun:test";
import { exposedLedgerToolsForRole } from "@cq/config";
import {
  LEDGER_TOOL_NAMES,
  MANAGEMENT_LEDGER_TOOL_NAMES,
  prefixedToolNames,
} from "@cq/ledger";
import { buildServerInstructions } from "../src/main.js";

/**
 * Byte-identity fixture: the ORIGINAL SERVER_INSTRUCTIONS body, verbatim, kept
 * here so the empty-prefix invariant is asserted against an INDEPENDENT copy of
 * the text (not against `buildServerInstructions` itself). Any prose drift in
 * the source must be mirrored here on purpose, or this test fails — which is the
 * point: `buildServerInstructions('')` MUST stay byte-identical to this text.
 */
const ORIGINAL_SERVER_INSTRUCTIONS = [
  "Typed milestone/item DAG. enumerate_ledgers schemas. Writes valid fields+author/session+canonical refs.",
  "Reads compact|complement|full; compact.fields ⊎ complement.fields = full.fields. fetch_ledger: paginate until nextOffset=null. fts_search defaults active+filters; terminal stays until fully-terminal archive_milestone.",
  "Plan/build: fts_search relevant active memories by ledger/status; fetch_item full matches. create_item only confirmed durable project facts in memories/M-AMBIENT with useful sourceRefs; exclude transient reasoning/session notes/unconfirmed preferences.",
  "Ideas omit milestone_id→M-AMBIENT; no work milestone/archive; ledgerRefs independent.",
  "CQ snapshot/derive_predicates; preserve IDs and dispatch/plan capability/generation/fence/recovery/idempotency.",
].join(" ");

const REQUIRED_INSTRUCTION_FACTS = [
  "Typed milestone/item DAG",
  "enumerate_ledgers schemas",
  "Writes valid fields+author/session+canonical refs",
  "compact.fields ⊎ complement.fields = full.fields",
  "fetch_ledger: paginate until nextOffset=null",
  "fts_search defaults active+filters",
  "terminal stays until fully-terminal archive_milestone",
  "Plan/build: fts_search relevant active memories by ledger/status; fetch_item full matches",
  "create_item only confirmed durable project facts in memories/M-AMBIENT with useful sourceRefs",
  "Ideas omit milestone_id→M-AMBIENT; no work milestone/archive; ledgerRefs independent",
  "exclude transient reasoning/session notes/unconfirmed preferences",
  "CQ snapshot/derive_predicates",
  "dispatch/plan capability/generation/fence/recovery/idempotency",
] as const;

function assertInstructionSemantics(text: string): void {
  for (const fact of REQUIRED_INSTRUCTION_FACTS) {
    if (!text.includes(fact)) throw new Error(`missing instruction fact: ${fact}`);
  }
}

describe("buildServerInstructions", () => {
  test("empty prefix is byte-identical to the original SERVER_INSTRUCTIONS text", () => {
    expect(buildServerInstructions("")).toBe(ORIGINAL_SERVER_INSTRUCTIONS);
  });

  test("prefixed output names tools in their prefixed form", () => {
    const text = buildServerInstructions("myproj");
    expect(text).toContain("myproj_enumerate_ledgers");
    expect(text).toContain("myproj_fts_search relevant active memories");
    expect(text).toContain("myproj_fetch_item full matches");
    expect(text).toContain("myproj_create_item only confirmed durable project facts");
    expect(text).toContain("myproj_snapshot");
  });

  test("canonical memory policy is explicit on the unprefixed surface", () => {
    const text = buildServerInstructions("");
    expect(text).toContain("fts_search defaults active+filters");
    expect(text).toContain("Writes valid fields+author/session+canonical refs.");
    expect(text).toContain(
      "Plan/build: fts_search relevant active memories by ledger/status; fetch_item full matches.",
    );
    expect(text).toContain(
      "create_item only confirmed durable project facts in memories/M-AMBIENT with useful sourceRefs; exclude transient reasoning/session notes/unconfirmed preferences.",
    );
  });

  test("a complete management profile retains the compact canonical instructions", () => {
    expect(buildServerInstructions("", "begin", MANAGEMENT_LEDGER_TOOL_NAMES)).toBe(
      ORIGINAL_SERVER_INSTRUCTIONS,
    );
  });

  test("canonical idea attachment policy is explicit on the unprefixed surface", () => {
    expect(buildServerInstructions("")).toContain(
      "Ideas omit milestone_id→M-AMBIENT; no work milestone/archive; ledgerRefs independent.",
    );
  });

  test("compact wording retains projection, pagination, and lifecycle invariants", () => {
    const text = buildServerInstructions("");
    expect(() => assertInstructionSemantics(text)).not.toThrow();
  });

  test("semantic guard rejects removal of every required instruction fact", () => {
    const text = buildServerInstructions("");
    for (const fact of REQUIRED_INSTRUCTION_FACTS) {
      const mutated = text.replace(fact, "");
      expect(mutated).not.toBe(text);
      expect(() => assertInstructionSemantics(mutated)).toThrow(
        `missing instruction fact: ${fact}`,
      );
    }
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
    // Pin the ordinary registered tool count so management-only operations cannot leak here.
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
