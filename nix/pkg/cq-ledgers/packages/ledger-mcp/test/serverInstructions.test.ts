import { describe, expect, test } from "bun:test";
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
  "This server is a markdown-backed planning ledger. Use it to track work as",
  "structured items instead of scratch notes or ad-hoc TODO files.",
  "",
  "Model: a `milestones` ledger holds milestones (which form a DAG via",
  "dependsOn/blockedBy); other ledgers (tasks, defects, hypothesis, questions,",
  "decisions, goals, researches) hold typed items, each attached to a milestone.",
  "",
  "When to use it:",
  "- At the start of multi-step work: create a milestone, then create_item the",
  "  tasks/defects/etc. under it.",
  "- As work proceeds: update_item status (e.g. planned→wip→done) so the ledger",
  "  reflects reality; record findings as hypothesis/decision/question items.",
  "- Before acting: fts_search / fetch_ledger to see what already exists; do not",
  "  duplicate an existing item. fts_search accepts filters, e.g.",
  '  `status:wip ledger:tasks`, `(status:done OR status:wip)`, `author:user`.',
  "- On completion: mark items terminal and archive_milestone once all its items",
  "  are terminal.",
  "",
  "Conventions: keep one item per discrete unit of work; put detail in the",
  "item's fields (markdown is supported); use enumerate_ledgers to discover",
  "ledgers and their schemas before creating items.",
  "",
  "Provenance: on every create_item / update_item, set `author` to your model",
  'class (e.g. "opus-4.8[1m]") and `session` to your CLAUDE_CODE_SESSION_ID so',
  "the ledger records who wrote each item. Human edits via the TUI/web editor",
  'set author to "user". These are optional intrinsic fields — not schema',
  "fields — so they apply to every ledger and never need a schema change.",
  "",
  "fts_search query notes:",
  "- Two paths for status filtering: (a) dedicated `status` param — a single",
  "  exact value pre-filtered before ranking; (b) inline status: qualifier in",
  "  the query string. Combine freely: status='wip' + query='ledger:tasks auth'.",
  "- OR-of-qualifiers work: '(status:open OR status:wip)' uses the structured",
  "  evaluator (not the MiniSearch fast path) and returns all matching items.",
  "- Active vs archived: fts_search covers active items by default; pass",
  "  include_archived:true to also search milestone-group archives.",
  "- Terminal vs active: terminalStatuses (done/resolved/abandoned etc.) are",
  "  still active (searchable, editable) until archive_milestone is called.",
  "  Use -status:done to exclude terminal items from results.",
  "",
  "Quick overview tools:",
  "- snapshot() — compact {id,status,summary} cross-ledger state in one call.",
  "- derive_predicates() — the /cq:advance flow-detection predicates",
  "  { pInvestigate, pSeed, pPlan, pResearch, pImplement, openQuestionGate,",
  "  belowFloor } in one call; read these instead of hand-deriving",
  "  actionability from snapshot.",
  "- fetch_ledger with compact:true — strips long narrative fields to avoid",
  "  token-overflow on large ledgers. Combine with offset/limit for pagination.",
].join("\n");

describe("buildServerInstructions", () => {
  test("empty prefix is byte-identical to the original SERVER_INSTRUCTIONS text", () => {
    expect(buildServerInstructions("")).toBe(ORIGINAL_SERVER_INSTRUCTIONS);
  });

  test("prefixed output names tools in their prefixed form", () => {
    const text = buildServerInstructions("myproj");
    expect(text).toContain("myproj_create_item");
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
    expect(LEDGER_TOOL_NAMES.length).toBe(26);
    for (const tok of emitted) {
      expect(allowed.has(tok)).toBe(true);
    }
  });
});
