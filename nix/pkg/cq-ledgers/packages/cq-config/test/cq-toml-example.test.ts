/**
 * T234: Reproducible test that verifies cq.toml.example (repo root) is
 * provider-qualified and resolves correctly under the T231 grammar.
 *
 * T274: Added regression guard — parseConfig on cq.toml.example must
 * succeed with no CqConfigError (ensures the shipped example always stays
 * valid under the current grammar), plus semantic assertions
 * (tierModel / resolveAgentModel) that catch a regression in the
 * tier->model [tiers] map, not just a parse failure.
 *
 * Acceptance:
 *  - The file contains no bare slash-free `pi:<word>` tokens.
 *  - parseConfig resolves the minimax alias to {harness:'pi', model:'minimax-m3', provider:'ollama-cloud'}.
 *  - parseConfig resolves the grok alias to {harness:'pi', model:'grok-build', provider:'grok-build'}.
 *  - parseConfig resolves codex/terra/luna aliases to the openai-codex GPT-5.6
 *    sol/terra/luna ladder (T864).
 *  - parseConfig does NOT throw (T274 regression guard).
 *  - tierModel(config, "frontier") returns the opus token (semantic guard).
 *  - resolveAgentModel for 'plan-reviewer' returns the opus token
 *    (semantic end-to-end guard).
 *
 * Uses parseConfig (not loadConfig) so the test reads cq.toml.example
 * directly and does not depend on the gitignored live cq.toml being present.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import {
  parseConfig,
  tierModel,
  resolveAgentModel,
  resolveReviewers,
  resolvePlanners,
  formatReviewerToken,
  type CqConfig,
} from "../src/index.js";

// Resolve the repo root by walking up 6 levels from this test file's directory:
// test/ -> cq-config/ -> packages/ -> cq-ledgers/ -> pkg/ -> nix/ -> repo root
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../../../");
const EXAMPLE_PATH = path.join(REPO_ROOT, "cq.toml.example");

describe("cq.toml.example — global configuration contract", () => {
  it("documents resolution, merge precedence, local-only tables, and sandbox visibility", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const normalized = contents
      .split("\n")
      .map((line) => line.replace(/^# ?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");
    for (const fact of [
      "GLOBAL CONFIG",
      "$XDG_CONFIG_HOME/cq/cq.toml",
      "non-empty absolute path",
      "~/.config/cq/cq.toml",
      "cq init --global",
      "[aliases], [tiers], [agent_tiers], and [agent_efforts] merge per key",
      "reviewers and planners replace their global arrays wholesale",
      "[webui] is replaced wholesale",
      "[harness.<name>] merges per field",
      "[ledger] and [project] are LOCAL-ONLY whole tables",
      "Project identity and storage selection belong to one repository",
      "global backend edit could silently relocate every repository's store",
      "partial [ledger] merges could compose an invalid backend configuration",
      "read-only inside the yolo sandbox",
    ]) {
      expect(normalized).toContain(fact);
    }
  });
});

// T274: Regression guard — the example file must parse cleanly with no CqConfigError.
describe("cq.toml.example — T274 regression guard: no CqConfigError", () => {
  it("parseConfig on cq.toml.example does not throw CqConfigError", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    expect(() => parseConfig(contents)).not.toThrow();
  });

  it("parseConfig on cq.toml.example yields a non-null tiers config", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    // The example has a [tiers] block, so tiers must be non-null.
    expect(config.tiers).not.toBeNull();
  });

  it("parseConfig on cq.toml.example yields non-null agentTiers", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(config.agentTiers).not.toBeNull();
  });

  it("parseConfig on cq.toml.example — [agent_efforts] is documented commented-out, so agentEfforts is {} (T518/Q254)", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(config.agentEfforts).toEqual({});
  });

  it("parseConfig on cq.toml.example — [tiers] entries carry resolved tokens", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    // Each entry in the parsed tiers.entries must have a resolved token
    // (not an alias stub) — confirms the tier->model map values are resolved
    // through [aliases] and parsed correctly.
    expect(config.tiers!.entries.length).toBeGreaterThan(0);
    for (const entry of config.tiers!.entries) {
      expect(entry.token.harness === "claude" || entry.token.harness === "pi").toBe(true);
      expect(entry.token.model).toBeTruthy();
    }
  });

  it("tierModel — 'frontier' resolves to the opus token (semantic map guard)", () => {
    // This test exercises the tier->model lookup itself, not just the parser.
    // A regression in tierModel (wrong equality, wrong return, wrong lookup)
    // would be caught here even if parseConfig still passes.
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(tierModel(config, "frontier")).toEqual(config.aliases["opus"]!);
  });

  it("tierModel — 'standard' resolves to sonnet and 'fast' resolves to haiku", () => {
    // The example [tiers] block maps standard = "sonnet" and fast = "haiku"
    // (alias-value form). Verify both are resolved through [aliases] to the
    // correct token, covering the remaining tiers of the map.
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(tierModel(config, "standard")).toEqual(config.aliases["sonnet"]!);
    expect(tierModel(config, "fast")).toEqual(config.aliases["haiku"]!);
  });

  it("resolveAgentModel — 'plan-reviewer' resolves to the opus token (end-to-end semantic guard)", () => {
    // plan-reviewer has agent_tiers entry 'frontier'; [tiers] maps frontier to
    // opus in the example.  This guard catches a regression in the full
    // resolveAgentModel pipeline (agent -> tier -> model).
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    const resolved = resolveAgentModel(config, "plan-reviewer");
    expect(resolved).toEqual(config.aliases["opus"]!);
  });
});

describe("cq.toml.example — T234 provider-qualification checks", () => {
  it("contains no bare slash-free pi:<word> tokens", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    // Match any `pi:` followed by one or more non-slash, non-whitespace, non-quote chars
    // without a subsequent `/` before the closing quote — i.e. a bare pi token.
    const bareMatch = contents.match(/"pi:[^/"'\s]+"/g);
    expect(bareMatch).toBeNull();
  });

  it("resolves minimax alias to {harness:'pi', model:'minimax-m3', provider:'ollama-cloud'}", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(config.aliases["minimax"]).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
      effort: null,
    });
  });

  it("resolves codex alias to {harness:'pi', model:'gpt-5.6-sol', provider:'openai-codex', effort:'xhigh'} (T864)", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(config.aliases["codex"]).toEqual({
      harness: "pi",
      model: "gpt-5.6-sol",
      provider: "openai-codex",
      effort: "xhigh",
    });
  });

  it("resolves terra/luna aliases to the GPT-5.6 standard/fast ladder (T864)", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(config.aliases["terra"]).toEqual({
      harness: "pi",
      model: "gpt-5.6-terra",
      provider: "openai-codex",
      effort: "high",
    });
    expect(config.aliases["luna"]).toEqual({
      harness: "pi",
      model: "gpt-5.6-luna",
      provider: "openai-codex",
      effort: "low",
    });
  });

  it("resolves grok alias to {harness:'pi', model:'grok-build', provider:'grok-build'}", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const config: CqConfig = parseConfig(contents);
    expect(config.aliases["grok"]).toEqual({
      harness: "pi",
      model: "grok-build",
      provider: "grok-build",
      effort: null,
    });
  });
});

/**
 * T864: the documented `[harness.pi]` / `[harness.codex]` examples (COMMENTED
 * OUT per T479 — cq.toml.example must carry no uncommented [harness.*] line)
 * are themselves schema-valid TOML that yields the documented GPT-5.6 ladder
 * once uncommented. Extracts the contiguous commented block starting at
 * "# [harness.pi]" (through the following blank line, i.e. past
 * "# [harness.codex.tiers]"'s three tier lines), strips the leading "# " on
 * each line, and appends the result — now live TOML — to the example's
 * existing (already-active) shared sections, so the aliases it references
 * resolve through the SAME [aliases] table documented above.
 */
function uncommentedHarnessExampleOverride(contents: string): string {
  const lines = contents.split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === "# [harness.pi]");
  expect(startIdx).toBeGreaterThan(-1);
  let endIdx = startIdx;
  while (endIdx < lines.length && lines[endIdx]!.startsWith("#")) {
    endIdx += 1;
  }
  // Only uncomment lines that are actual TOML content (a table header or a
  // key = value pair) — the block also carries plain-English prose comments
  // (e.g. the "EXAMPLE — activate the codex..." lead-in) that must stay
  // comments, not be fed to the TOML parser as bare text.
  return lines
    .slice(startIdx, endIdx)
    .map((line) => {
      const stripped = line.replace(/^#\s?/, "");
      const isTomlContent =
        /^\[[\w.]+\]\s*(#.*)?$/.test(stripped) || /^[\w-]+\s*=\s*\S/.test(stripped);
      return isTomlContent ? stripped : line;
    })
    .join("\n");
}

describe("cq.toml.example — T864: the codex CONFIGURATION SELECTOR is documented and schema-valid", () => {
  it("has no uncommented [harness.*] line (T479 precondition still holds after T864)", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const harnessLine = contents.split("\n").find((line) => /^\[harness\./.test(line));
    expect(harnessLine).toBeUndefined();
  });

  it("uncommenting the documented [harness.pi]/[harness.codex] examples parses and resolves the GPT-5.6 ladder, with no active opus under codex", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const override = uncommentedHarnessExampleOverride(contents);
    // Sanity: the extracted, uncommented override actually declares both blocks.
    expect(override).toContain("[harness.pi]");
    expect(override).toContain("[harness.codex]");
    expect(override).toContain("[harness.codex.tiers]");

    const withHarness = `${contents}\n${override}\n`;

    const pi = parseConfig(withHarness, "pi");
    const codex = parseConfig(withHarness, "codex");

    expect(codex.dispatchViolation).toBeNull();

    const CODEX_TOKEN = "pi:openai-codex/gpt-5.6-sol:xhigh";
    const TERRA_TOKEN = "pi:openai-codex/gpt-5.6-terra:high";
    const LUNA_TOKEN = "pi:openai-codex/gpt-5.6-luna:low";

    // The pi selector's panel mirrors CQ_TOML_TEMPLATE: grok + codex reviewers,
    // codex-only planners.
    expect(resolveReviewers(pi).map(formatReviewerToken)).toEqual([
      "pi:grok-build/grok-build",
      CODEX_TOKEN,
    ]);
    expect(resolvePlanners(pi).map(formatReviewerToken)).toEqual([CODEX_TOKEN]);
    expect(formatReviewerToken(tierModel(pi, "frontier")!)).toBe(CODEX_TOKEN);
    expect(formatReviewerToken(tierModel(pi, "standard")!)).toBe(TERRA_TOKEN);
    expect(formatReviewerToken(tierModel(pi, "fast")!)).toBe(LUNA_TOKEN);

    // The codex selector's panel/tiers resolve EXCLUSIVELY to the same
    // OpenAI-Codex-backed GPT-5.6 ladder — no active opus, no active claude
    // token of any kind.
    expect(resolveReviewers(codex).map(formatReviewerToken)).toEqual([CODEX_TOKEN]);
    expect(resolvePlanners(codex).map(formatReviewerToken)).toEqual([CODEX_TOKEN]);
    expect(formatReviewerToken(tierModel(codex, "frontier")!)).toBe(CODEX_TOKEN);
    expect(formatReviewerToken(tierModel(codex, "standard")!)).toBe(TERRA_TOKEN);
    expect(formatReviewerToken(tierModel(codex, "fast")!)).toBe(LUNA_TOKEN);
    for (const token of [
      ...resolveReviewers(codex),
      ...resolvePlanners(codex),
      tierModel(codex, "frontier")!,
      tierModel(codex, "standard")!,
      tierModel(codex, "fast")!,
    ]) {
      expect(token.harness).not.toBe("claude");
    }
    // The shared opus alias stays defined — legal, INACTIVE, under codex.
    expect(codex.aliases["opus"]).toBeDefined();

    // The claude selector is untouched by the appended pi/codex override.
    const claude = parseConfig(withHarness, "claude");
    expect(claude).toEqual(parseConfig(contents, "claude"));
  });

  it("an incomplete [harness.codex] override (e.g. missing tiers) still fails closed under codex, exactly like T861's rule", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    const override = uncommentedHarnessExampleOverride(contents);
    // Drop the [harness.codex.tiers] section (and its three tier lines) to
    // simulate an incomplete override — the FAIL-CLOSED rule must reject it.
    const partial = override.replace(/\[harness\.codex\.tiers\][\s\S]*/, "");
    const withPartialHarness = `${contents}\n${partial}\n`;
    const codex = parseConfig(withPartialHarness, "codex");
    expect(codex.dispatchViolation).toMatch(/tiers/);
  });
});
