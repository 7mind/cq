/**
 * T861: `codex` as an ACTIVE CONFIGURATION SELECTOR, distinct from the
 * EXECUTABLE DISPATCH-TOKEN domain.
 *
 * Two vocabularies are deliberately separated here:
 *
 *  1. {@link ActiveHarness} (`claude | pi | codex`) — which `[harness.*]` block
 *     is in force for this invocation. `CQ_HARNESS`, `parseConfig`'s
 *     `activeHarness` argument, `loadConfig`'s `harness` argument, and the
 *     `[harness.<name>]` TOML keys all live in THIS domain.
 *  2. {@link Harness} (`claude | pi`) — who can actually be INVOKED as a
 *     reviewer / planner / tier model. The `ReviewerToken` grammar, the effort
 *     vocabularies, and the dispatch model-mapping keys stay in THIS domain,
 *     because cq has no Codex dispatch transport.
 *
 * FAIL-CLOSED CODEX RULE (deliberately narrower than Q239's general layered
 * fallback): under an ACTIVE `codex` selector the `[harness.codex]` block must
 * exist and must itself provide `reviewers`, `planners`, AND `tiers` — there is
 * no silent fall-through to the shared top-level defaults — and every alias the
 * active panels reference must resolve to a NON-CLAUDE executable token. Shared
 * Claude aliases remain perfectly legal as INACTIVE definitions.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ACTIVE_HARNESSES,
  CqConfigError,
  DEFAULT_HARNESS,
  HARNESSES,
  isActiveHarness,
  isEffort,
  isHarness,
  loadConfig,
  parseConfig,
  parseReviewerToken,
  resolveActiveHarness,
  resolvePlanners,
  resolveReviewers,
  tierModel,
  type ActiveHarness,
  type Harness,
  type ReviewerToken,
  type TierEntry,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

// ---- Type-level pins: the two domains must NOT collapse into one -----------

/** The ACTIVE configuration-selector domain gains codex. */
const activeSelectorDomainIncludesCodex: Equal<ActiveHarness, "claude" | "pi" | "codex"> = true;
/** The EXECUTABLE dispatch-token domain does NOT. */
const dispatchTokenDomainStaysExecutable: Equal<Harness, "claude" | "pi"> = true;
/** Every executable harness is also a selectable configuration selector. */
const everyDispatchHarnessIsSelectable: Equal<Extract<ActiveHarness, Harness>, "claude" | "pi"> =
  true;
/** A parsed reviewer/planner token can never name a codex transport. */
const reviewerTokenHarnessStaysExecutable: Equal<ReviewerToken["harness"], "claude" | "pi"> = true;
/** Nor can a `[tiers]` dispatch entry. */
const tierEntryTokenStaysExecutable: Equal<TierEntry["token"]["harness"], "claude" | "pi"> = true;
/** The effort rules are keyed on the executable domain, so codex has no efforts. */
const effortRulesStayExecutable: Equal<Parameters<typeof isEffort>[0], Harness> = true;
/** Each guard narrows to its OWN domain and no further. */
const activeGuardNarrowsToSelector: (value: string) => value is ActiveHarness = isActiveHarness;
const dispatchGuardNarrowsToHarness: (value: string) => value is Harness = isHarness;

/**
 * A complete, fail-closed-compliant codex configuration: `[harness.codex]`
 * supplies all three required sections and every active alias resolves to a pi
 * (non-claude) executable token. The shared top-level panels stay Claude — they
 * are INACTIVE under the codex selector.
 */
const CODEX_TOML = `
reviewers = ["opus"]
planners = ["opus"]

[aliases]
opus = "claude:opus-4.8[1m]"
grok = "pi:grok-build/grok-build"
minimax = "pi:ollama-cloud/minimax-m3"

[tiers]
frontier = "opus"

[harness.codex]
reviewers = ["grok"]
planners = ["minimax"]

[harness.codex.tiers]
frontier = "grok"
standard = "minimax"
fast = "pi:grok-build/grok-build:low"
`;

/** Materialise `contents` as a cq.toml inside a fresh temporary repo root. */
function writeCqToml(contents: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "cq-config-codex-"));
  writeFileSync(path.join(root, "cq.toml"), contents, "utf8");
  return root;
}

describe("T861: the active configuration-selector vocabulary admits codex", () => {
  it("keeps the two vocabularies distinct at runtime", () => {
    expect(activeSelectorDomainIncludesCodex).toBe(true);
    expect(dispatchTokenDomainStaysExecutable).toBe(true);
    expect(everyDispatchHarnessIsSelectable).toBe(true);
    expect(reviewerTokenHarnessStaysExecutable).toBe(true);
    expect(tierEntryTokenStaysExecutable).toBe(true);
    expect(effortRulesStayExecutable).toBe(true);

    expect(ACTIVE_HARNESSES).toEqual(["claude", "pi", "codex"]);
    expect(HARNESSES).toEqual(["claude", "pi"]);

    expect(activeGuardNarrowsToSelector("codex")).toBe(true);
    expect(dispatchGuardNarrowsToHarness("codex")).toBe(false);
    expect(isActiveHarness("codex")).toBe(true);
    expect(isHarness("codex")).toBe(false);
    expect(isActiveHarness("bogus")).toBe(false);

    // Every executable transport is selectable; the converse does not hold.
    for (const harness of HARNESSES) {
      expect(isActiveHarness(harness)).toBe(true);
    }
    expect(HARNESSES.length).toBeLessThan(ACTIVE_HARNESSES.length);

    // codex has no effort vocabulary of its own — efforts are keyed on the
    // executable transports only.
    expect(isEffort("pi", "xhigh")).toBe(true);
    expect(isEffort("claude", "off")).toBe(false);
  });

  it("resolves CQ_HARNESS=codex to the codex selector", () => {
    expect(resolveActiveHarness({ CQ_HARNESS: "codex" })).toBe("codex");
  });

  it("still rejects a bogus selector and preserves the Claude default + session inference", () => {
    expect(() => resolveActiveHarness({ CQ_HARNESS: "bogus" })).toThrow(CqConfigError);
    expect(() => resolveActiveHarness({ CQ_HARNESS: "codexx" })).toThrow(CqConfigError);
    expect(resolveActiveHarness({})).toBe(DEFAULT_HARNESS);
    expect(DEFAULT_HARNESS).toBe("claude");
    expect(resolveActiveHarness({ CLAUDE_CODE_SESSION_ID: "abc-123" })).toBe("claude");
    // An explicit codex signal still beats a Claude session id.
    expect(
      resolveActiveHarness({ CQ_HARNESS: "codex", CLAUDE_CODE_SESSION_ID: "abc-123" }),
    ).toBe("codex");
  });

  it("never lets codex become a dispatchable reviewer/planner token", () => {
    expect(() => parseReviewerToken("codex:gpt-5.4")).toThrow(CqConfigError);
    expect(() => parseReviewerToken("codex:gpt-5.4")).toThrow(/unknown harness "codex"/);
    expect(() => parseReviewerToken("codex:openai/gpt-5.4")).toThrow(CqConfigError);
  });
});

describe("T861: [harness.codex] parses and merges", () => {
  it("accepts a complete [harness.codex] / [harness.codex.tiers] block", () => {
    const codex = parseConfig(CODEX_TOML, "codex");
    expect(codex.reviewers).toEqual(["grok"]);
    expect(codex.planners).toEqual(["minimax"]);
    expect(resolveReviewers(codex)).toEqual([parseReviewerToken("pi:grok-build/grok-build")]);
    expect(resolvePlanners(codex)).toEqual([parseReviewerToken("pi:ollama-cloud/minimax-m3")]);
    expect(tierModel(codex, "frontier")).toEqual(parseReviewerToken("pi:grok-build/grok-build"));
    expect(tierModel(codex, "standard")).toEqual(
      parseReviewerToken("pi:ollama-cloud/minimax-m3"),
    );
    expect(tierModel(codex, "fast")).toEqual(
      parseReviewerToken("pi:grok-build/grok-build:low"),
    );
    // The shared [aliases] table stays intact — Claude aliases are legal
    // INACTIVE definitions under the codex selector.
    expect(codex.aliases["opus"]).toEqual(parseReviewerToken("claude:opus-4.8[1m]"));
  });

  it("loads the same document from disk under harness='codex'", () => {
    const root = writeCqToml(CODEX_TOML);
    try {
      const codex = loadConfig(root, "codex");
      expect(codex).not.toBeNull();
      expect(codex!.reviewers).toEqual(["grok"]);
      expect(codex!.planners).toEqual(["minimax"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves the Claude and Pi selectors on the shared panels", () => {
    const claude = parseConfig(CODEX_TOML, "claude");
    expect(claude.reviewers).toEqual(["opus"]);
    expect(claude.planners).toEqual(["opus"]);
    expect(tierModel(claude, "frontier")).toEqual(parseReviewerToken("claude:opus-4.8[1m]"));

    const pi = parseConfig(CODEX_TOML, "pi");
    expect(pi).toEqual(claude);

    // The omitted-argument default reproduces the pre-T861 Claude behaviour.
    expect(parseConfig(CODEX_TOML)).toEqual(claude);
  });

  it("parses a flat cq.toml identically under the claude and pi selectors", () => {
    const flat = `
reviewers = ["opus", "grok"]
planners = ["opus"]

[aliases]
opus = "claude:opus-4.8[1m]"
grok = "pi:grok-build/grok-build"

[tiers]
frontier = "opus"
standard = "grok"
`;
    const underClaude = parseConfig(flat, "claude");
    expect(parseConfig(flat, "pi")).toEqual(underClaude);
    expect(parseConfig(flat)).toEqual(underClaude);
    expect(underClaude.reviewers).toEqual(["opus", "grok"]);
    // ...but a flat document is NOT a valid codex configuration: the codex
    // selector narrows Q239's fallback and demands its own block.
    expect(() => parseConfig(flat, "codex")).toThrow(/\[harness\.codex\]/);
  });
});

describe("T861: the codex selector is FAIL-CLOSED", () => {
  it("rejects a document with no [harness.codex] block at all", () => {
    const noCodex = `
reviewers = ["opus"]
planners = ["opus"]

[aliases]
opus = "claude:opus-4.8[1m]"

[tiers]
frontier = "opus"
`;
    expect(() => parseConfig(noCodex, "codex")).toThrow(CqConfigError);
    expect(() => parseConfig(noCodex, "codex")).toThrow(/\[harness\.codex\]/);
    // The very same document is fine under claude / pi.
    expect(() => parseConfig(noCodex, "claude")).not.toThrow();
    expect(() => parseConfig(noCodex, "pi")).not.toThrow();
  });

  it("rejects an omitted reviewers section instead of falling back to the shared list", () => {
    const src = `
reviewers = ["grok"]
planners = ["grok"]

[aliases]
grok = "pi:grok-build/grok-build"

[harness.codex]
planners = ["grok"]

[harness.codex.tiers]
frontier = "grok"
`;
    expect(() => parseConfig(src, "codex")).toThrow(/reviewers/);
  });

  it("rejects an omitted planners section", () => {
    const src = `
[aliases]
grok = "pi:grok-build/grok-build"

[harness.codex]
reviewers = ["grok"]

[harness.codex.tiers]
frontier = "grok"
`;
    expect(() => parseConfig(src, "codex")).toThrow(/planners/);
  });

  it("rejects an omitted tiers section", () => {
    const src = `
[tiers]
frontier = "grok"

[aliases]
grok = "pi:grok-build/grok-build"

[harness.codex]
reviewers = ["grok"]
planners = ["grok"]
`;
    expect(() => parseConfig(src, "codex")).toThrow(/tiers/);
  });

  it("rejects an ACTIVE reviewer alias that resolves to a claude token", () => {
    const src = `
[aliases]
opus = "claude:opus-4.8[1m]"
grok = "pi:grok-build/grok-build"

[harness.codex]
reviewers = ["opus"]
planners = ["grok"]

[harness.codex.tiers]
frontier = "grok"
`;
    expect(() => parseConfig(src, "codex")).toThrow(CqConfigError);
    expect(() => parseConfig(src, "codex")).toThrow(/claude/);
  });

  it("rejects an ACTIVE planner alias that resolves to a claude token", () => {
    const src = `
[aliases]
opus = "claude:opus-4.8[1m]"
grok = "pi:grok-build/grok-build"

[harness.codex]
reviewers = ["grok"]
planners = ["opus"]

[harness.codex.tiers]
frontier = "grok"
`;
    expect(() => parseConfig(src, "codex")).toThrow(/claude/);
  });

  it("rejects an ACTIVE tier that resolves to a claude token (alias or bare)", () => {
    const viaAlias = `
[aliases]
opus = "claude:opus-4.8[1m]"
grok = "pi:grok-build/grok-build"

[harness.codex]
reviewers = ["grok"]
planners = ["grok"]

[harness.codex.tiers]
frontier = "opus"
`;
    expect(() => parseConfig(viaAlias, "codex")).toThrow(/claude/);

    const viaBareToken = `
[aliases]
grok = "pi:grok-build/grok-build"

[harness.codex]
reviewers = ["grok"]
planners = ["grok"]

[harness.codex.tiers]
frontier = "claude:opus-4.8[1m]"
`;
    expect(() => parseConfig(viaBareToken, "codex")).toThrow(/claude/);
  });

  it("keeps shared Claude aliases legal as INACTIVE definitions", () => {
    // `opus` is declared, referenced by the shared panels, and referenced by
    // [harness.claude] — none of that is ACTIVE under the codex selector.
    const src = `
reviewers = ["opus"]
planners = ["opus"]

[aliases]
opus = "claude:opus-4.8[1m]"
sonnet = "claude:sonnet-4.8"
grok = "pi:grok-build/grok-build"

[tiers]
frontier = "opus"
standard = "sonnet"

[harness.claude]
reviewers = ["sonnet"]
planners = ["opus"]

[harness.claude.tiers]
frontier = "opus"

[harness.codex]
reviewers = ["grok"]
planners = ["grok"]

[harness.codex.tiers]
frontier = "grok"
`;
    const codex = parseConfig(src, "codex");
    expect(codex.reviewers).toEqual(["grok"]);
    expect(Object.keys(codex.aliases).sort()).toEqual(["grok", "opus", "sonnet"]);
    // ...and the claude selector still works off its own block.
    const claude = parseConfig(src, "claude");
    expect(claude.reviewers).toEqual(["sonnet"]);
  });

  it("fails eagerly on an ACTIVE dangling alias", () => {
    const src = `
[aliases]
grok = "pi:grok-build/grok-build"

[harness.codex]
reviewers = ["nonexistent"]
planners = ["grok"]

[harness.codex.tiers]
frontier = "grok"
`;
    expect(() => parseConfig(src, "codex")).toThrow(CqConfigError);
    expect(() => parseConfig(src, "codex")).toThrow(/nonexistent/);

    const root = writeCqToml(src);
    try {
      expect(() => loadConfig(root, "codex")).toThrow(CqConfigError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
