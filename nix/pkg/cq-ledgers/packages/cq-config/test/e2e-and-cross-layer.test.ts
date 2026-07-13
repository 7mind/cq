/**
 * T238: @cq/config end-to-end + cross-layer consistency tests.
 *
 * (1) End-to-end resolve test: a cq.toml with minimax alias, reviewers/planners
 *     referencing minimax, and [tiers]/[agent_tiers] — resolveReviewers/
 *     resolvePlanners return tokens with provider:'ollama-cloud', model:'minimax-m3'.
 *
 * (2) Bare-pi rejection test: a cq.toml with a bare pi:<model> (no provider
 *     qualifier) throws CqConfigError at parse/load time.
 *
 * (3) Cross-layer consistency test (K50 regression guard): a LOCAL REPLICA of
 *     the extension's tokenToChildModel logic (from
 *     nix/pkg/pi-extensions/cq-subagent-dispatch.ts, the T233 version) is
 *     asserted to agree with parseReviewerToken on the pi fixture cases.
 *     The replica faithfully copies tokenToChildModel (harness !== 'pi' → null;
 *     no slash → null; empty half → null; else {provider, model}).
 *     Over pi tokens: parseReviewerToken ACCEPTS iff replica ACCEPTS, and when
 *     both accept they agree on provider+model.
 *     Over claude tokens: each layer's independent expected behavior is asserted.
 *
 * (4) Q165 pi-extension effort mirror (T294, R342): the replica is extended with
 *     the effort suffix + the childArgs `--model` builder and asserts pi emits
 *     effort as the `<provider>/<model>:<effort>` shorthand (NO '--thinking'),
 *     claude records effort inertly with a parent fallback, and the lenient
 *     unsupported-effort policy (null, not throw) diverges from @cq/config.
 *
 * (5) D79 (5c) extension/config PARITY test (T511): reads the ACTUAL source of
 *     nix/pkg/pi-extensions/cq-subagent-dispatch.ts (not a hand-typed replica)
 *     and extracts its live PI_EFFORTS / CLAUDE_EFFORTS Set literals, asserting
 *     set-EQUALITY against @cq/config's exported PI_EFFORTS / CLAUDE_EFFORTS —
 *     so drift on EITHER side (the extension forgetting a new effort, or
 *     @cq/config gaining one the extension doesn't mirror) fails a test. Also
 *     asserts the working dispatch path (replicaBuildModelArgs) emits
 *     ':none'/':max' onto the child --model, without regressing the existing
 *     R342 emission for off/minimal/low/medium/high/xhigh.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import {
  parseConfig,
  parseReviewerToken,
  resolveReviewers,
  resolvePlanners,
  resolveAgentModel,
  CqConfigError,
  PI_EFFORTS,
  CLAUDE_EFFORTS,
} from "../src/index.js";

// ── (1) End-to-end resolve test ──────────────────────────────────────────────

const E2E_TOML = `
reviewers = ["minimax", "opus"]
planners = ["minimax"]

[aliases]
minimax = "pi:ollama-cloud/minimax-m3"
opus    = "claude:opus-4.8[1m]"

[tiers]
standard = "minimax"
frontier = "opus"

[agent_tiers]
implement-worker     = "standard"
implement-reviewer   = "standard"
investigate-explorer = "frontier"
`;

describe("end-to-end resolve — minimax alias through reviewers/planners (T238)", () => {
  it("resolveReviewers returns provider:'ollama-cloud', model:'minimax-m3' for minimax", () => {
    const config = parseConfig(E2E_TOML);
    const resolved = resolveReviewers(config);
    expect(resolved[0]).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
      effort: null,
    });
    // second reviewer (opus) is claude
    expect(resolved[1]).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
  });

  it("resolvePlanners returns provider:'ollama-cloud', model:'minimax-m3' for minimax", () => {
    const config = parseConfig(E2E_TOML);
    const resolved = resolvePlanners(config);
    expect(resolved).toEqual([
      {
        harness: "pi",
        model: "minimax-m3",
        provider: "ollama-cloud",
        effort: null,
      },
    ]);
  });

  it("resolveAgentModel resolves implement-worker -> standard -> minimax -> provider+model", () => {
    const config = parseConfig(E2E_TOML);
    expect(resolveAgentModel(config, "implement-worker")).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
      effort: null,
    });
  });

  it("resolveAgentModel resolves investigate-explorer -> frontier -> opus -> claude", () => {
    const config = parseConfig(E2E_TOML);
    expect(resolveAgentModel(config, "investigate-explorer")).toEqual({
      harness: "claude",
      model: "opus-4.8[1m]",
      provider: null,
      effort: null,
    });
  });

  it("minimax alias in [aliases] parses to the expected ReviewerToken", () => {
    const config = parseConfig(E2E_TOML);
    expect(config.aliases["minimax"]).toEqual({
      harness: "pi",
      model: "minimax-m3",
      provider: "ollama-cloud",
      effort: null,
    });
  });
});

// ── (2) Bare-pi rejection test ───────────────────────────────────────────────

describe("bare-pi rejection at parse/load time (T238)", () => {
  it("throws CqConfigError when [aliases] contains a bare pi token", () => {
    expect(() =>
      parseConfig(`
[aliases]
minimax = "pi:minimax-m3"
`),
    ).toThrow(CqConfigError);
  });

  it("bare pi in reviewers alias throws at parseConfig (not deferred to resolve)", () => {
    expect(() =>
      parseConfig(`
reviewers = ["minimax"]
[aliases]
minimax = "pi:minimax-m3"
`),
    ).toThrow(CqConfigError);
  });

  it("throws CqConfigError when a [tiers] VALUE is a bare pi token", () => {
    expect(() =>
      parseConfig(`
[tiers]
standard = "pi:minimax-m3"
`),
    ).toThrow(CqConfigError);
  });

  it("the CqConfigError message mentions provider qualifier or bare token", () => {
    let caught: unknown;
    try {
      parseConfig(`
[aliases]
minimax = "pi:minimax-m3"
`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CqConfigError);
    expect((caught as CqConfigError).message).toMatch(/provider|bare/i);
  });
});

// ── (3) Cross-layer consistency test (K50 regression guard) ──────────────────
//
// LOCAL REPLICA of parseCqToken / tokenToChildModel + the childArgs `--model`
// builder from nix/pkg/pi-extensions/cq-subagent-dispatch.ts (T294 version,
// extending the T233 replica with the R342 effort suffix). These functions are
// COPIED, not imported — the extension is a standalone store-path file outside
// the cq-ledgers workspace and cannot be imported here. Keep in sync with the
// extension.
//
// Logic (T294 version):
//  parseCqToken("<harness>:<model>[:<effort>]"):
//   - first ':' splits harness from remainder; empty harness/remainder → null
//   - harness must be 'claude' | 'pi' → else null
//   - OPTIONAL trailing effort split off the LAST ':' of the remainder, kept
//     ONLY when isEffort(harness, suffix) (PI_EFFORTS / CLAUDE_EFFORTS)
//   - after stripping a valid effort, a residual ':' in the model → null
//     (R342: reserved; lenient mirror of @cq/config's fail-fast throw)
//  tokenToChildModel:
//   - harness !== 'pi' → null (claude cannot drive a child pi process; falls back)
//   - no '/' in model → null (bare pi token — REFUSED, mirrors @cq/config THROW)
//   - empty provider/model half → null (empty half — REFUSED)
//   - else → {provider, model, effort}
//  buildChildModelArg(model, emittedEffort): the `--model` value the extension
//   pushes — `<model>:<effort>` when an effort rides along (pi path only), else
//   `<model>`. NO separate '--thinking' token is ever emitted.

const PI_EFFORTS_REPLICA = new Set([
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const CLAUDE_EFFORTS_REPLICA = new Set(["low", "medium", "high", "xhigh", "max"]);

function replicaIsEffort(harness: string, value: string): boolean {
  return (harness === "pi" ? PI_EFFORTS_REPLICA : CLAUDE_EFFORTS_REPLICA).has(
    value,
  );
}

interface CqTokenReplica {
  harness: string;
  model: string;
  effort: string | null;
}

function replicaTokenToChildModel(
  token: CqTokenReplica,
): { provider: string | null; model: string; effort: string | null } | null {
  if (token.harness !== "pi") return null;
  const slash = token.model.indexOf("/");
  if (slash < 0) return null; // bare pi token — REFUSED (mirror @cq/config THROW)
  const provider = token.model.slice(0, slash);
  const model = token.model.slice(slash + 1);
  if (provider === "" || model === "") return null; // empty half — REFUSED
  return { provider, model, effort: token.effort };
}

/**
 * Parse a raw token string into a CqTokenReplica using the same logic as
 * parseCqToken in cq-subagent-dispatch.ts (lenient: returns null instead of
 * throwing). This is the replica's string entry point.
 */
function replicaParseCqToken(token: string): CqTokenReplica | null {
  const sep = token.indexOf(":");
  if (sep < 0) return null;
  const harness = token.slice(0, sep);
  const remainder = token.slice(sep + 1);
  if (harness === "" || remainder === "") return null;
  if (harness !== "claude" && harness !== "pi") return null;
  let model = remainder;
  let effort: string | null = null;
  const lastColon = remainder.lastIndexOf(":");
  if (lastColon >= 0) {
    const candidate = remainder.slice(lastColon + 1);
    if (replicaIsEffort(harness, candidate)) {
      effort = candidate;
      model = remainder.slice(0, lastColon);
    }
  }
  if (model === "") return null;
  if (model.includes(":")) return null; // R342 reserved residual ':' → null
  return { harness, model, effort };
}

/**
 * Combined replica: parse string token then apply tokenToChildModel.
 * Returns null when either step rejects.
 */
function replicaParseAndConvert(
  token: string,
): { provider: string | null; model: string; effort: string | null } | null {
  const cqToken = replicaParseCqToken(token);
  if (cqToken === null) return null;
  return replicaTokenToChildModel(cqToken);
}

/**
 * Replica of the extension's childArgs `--model` construction (R342): the
 * value pushed after "--model". An effort rides along as the
 * `<model>:<effort>` thinking-level shorthand ONLY on the pi path; the claude
 * fallback never appends (it keeps the parent model). Returns the FULL argv the
 * extension would build for the model selection, so a test can assert that no
 * "--thinking" token is ever present.
 */
function replicaBuildModelArgs(
  child: { provider: string | null; model: string; effort: string | null } | null,
): string[] {
  if (child === null) return []; // parent fallback — extension uses ctx.model
  const args: string[] = [];
  if (child.provider) args.push("--provider", child.provider);
  args.push("--model", child.effort ? `${child.model}:${child.effort}` : child.model);
  return args;
}

// Fixture table for pi tokens — the core K50 regression guard.
// ACCEPT iff ACCEPT + agreement invariant applies to these rows.
const PI_ACCEPT_CASES: Array<{
  token: string;
  expectedProvider: string;
  expectedModel: string;
}> = [
  {
    token: "pi:ollama-cloud/minimax-m3",
    expectedProvider: "ollama-cloud",
    expectedModel: "minimax-m3",
  },
  {
    token: "pi:grok-build/grok-build",
    expectedProvider: "grok-build",
    expectedModel: "grok-build",
  },
];

const PI_REJECT_CASES: string[] = [
  "pi:minimax-m3", // bare pi — no provider qualifier
  "pi:p/", // empty model half
  "pi:/m", // empty provider half
];

describe("cross-layer consistency: pi tokens (K50 regression guard, T238)", () => {
  // Accepted pi tokens: parseReviewerToken ACCEPTS iff replica ACCEPTS, and agree.
  for (const { token, expectedProvider, expectedModel } of PI_ACCEPT_CASES) {
    it(`BOTH accept "${token}" and agree on provider='${expectedProvider}' model='${expectedModel}'`, () => {
      // parseReviewerToken must accept
      const parsed = parseReviewerToken(token);
      expect(parsed.harness).toBe("pi");
      expect(parsed.provider).toBe(expectedProvider);
      expect(parsed.model).toBe(expectedModel);

      // replica must also accept and agree
      const replica = replicaParseAndConvert(token);
      expect(replica).not.toBeNull();
      expect(replica!.provider).toBe(expectedProvider);
      expect(replica!.model).toBe(expectedModel);
    });
  }

  // Rejected pi tokens: parseReviewerToken THROWS and replica returns null.
  for (const token of PI_REJECT_CASES) {
    it(`BOTH refuse "${token}" — parseReviewerToken throws and replica returns null`, () => {
      // parseReviewerToken must throw
      expect(() => parseReviewerToken(token)).toThrow(CqConfigError);

      // replica must also refuse (return null)
      const replica = replicaParseAndConvert(token);
      expect(replica).toBeNull();
    });
  }
});

describe("cross-layer consistency: claude tokens (T238)", () => {
  it("claude:opus-4.8[1m] — parseReviewerToken accepts with provider:null", () => {
    const parsed = parseReviewerToken("claude:opus-4.8[1m]");
    expect(parsed.harness).toBe("claude");
    expect(parsed.model).toBe("opus-4.8[1m]");
    expect(parsed.provider).toBeNull();
  });

  it("claude:opus-4.8[1m] — replica parseCqToken recognizes the token (harness=claude, no provider)", () => {
    // parseCqToken accepts it; tokenToChildModel returns null (claude cannot
    // drive a child pi process — caller falls back to the parent model).
    const cqToken = replicaParseCqToken("claude:opus-4.8[1m]");
    expect(cqToken).not.toBeNull();
    expect(cqToken!.harness).toBe("claude");
    expect(cqToken!.model).toBe("opus-4.8[1m]");
    // tokenToChildModel returns null for any claude token
    expect(replicaTokenToChildModel(cqToken!)).toBeNull();
  });

  it("claude:x/y — parseReviewerToken THROWS (claude rejects provider qualifier)", () => {
    expect(() => parseReviewerToken("claude:x/y")).toThrow(CqConfigError);
  });

  it("claude:x/y — replica replicaParseAndConvert returns null (harness=claude falls back, no pi child model)", () => {
    // parseCqToken returns {harness:'claude', model:'x/y'}; tokenToChildModel
    // returns null (harness !== 'pi'). Both refuse to produce a usable pi child model.
    const replica = replicaParseAndConvert("claude:x/y");
    expect(replica).toBeNull();
  });
});

// ── (4) Q165 pi-extension effort mirror test (T294, R342) ────────────────────
//
// Exercises the pure resolver functions (parseCqToken / tokenToChildModel) + the
// childArgs `--model` builder WITHOUT spawning. Asserts the R342 emission
// contract: pi's reasoning effort is the thinking-level SHORTHAND appended to
// the --model token (`<provider>/<model>:<effort>`), NEVER a separate
// '--thinking' flag. Also asserts agreement with @cq/config parseReviewerToken
// where the grammars overlap, and pins the lenient unsupported-effort policy.
describe("Q165 pi-extension effort mirror (T294, R342)", () => {
  it("(a) pi:grok-build/grok-build:xhigh — effort 'xhigh'; child --model is 'grok-build/grok-build:xhigh'; NO --thinking", () => {
    const token = replicaParseCqToken("pi:grok-build/grok-build:xhigh");
    expect(token).not.toBeNull();
    expect(token!.harness).toBe("pi");
    expect(token!.model).toBe("grok-build/grok-build");
    expect(token!.effort).toBe("xhigh");

    const child = replicaTokenToChildModel(token!);
    expect(child).not.toBeNull();
    expect(child!.provider).toBe("grok-build");
    expect(child!.model).toBe("grok-build");
    expect(child!.effort).toBe("xhigh");

    const modelArgs = replicaBuildModelArgs(child);
    // The extension splits the provider out: it pushes `--provider <provider>`
    // and `--model <model>:<effort>` (the effort rides on the --model token as
    // pi's thinking-level shorthand). For pi:grok-build/grok-build:xhigh that is
    // `--provider grok-build --model grok-build:xhigh`.
    expect(modelArgs).toEqual([
      "--provider",
      "grok-build",
      "--model",
      "grok-build:xhigh",
    ]);
    const modelIdx = modelArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(modelArgs[modelIdx + 1]).toBe("grok-build:xhigh");
    // The fully-qualified model token the child resolves to (the acceptance's
    // `provider/model:effort` form) is the provider re-joined to the --model
    // shorthand — confirming the effort is the `:<effort>` suffix.
    expect(`${child!.provider}/${modelArgs[modelIdx + 1]}`).toBe(
      "grok-build/grok-build:xhigh",
    );
    // CRITICAL: no separate --thinking token anywhere.
    expect(modelArgs).not.toContain("--thinking");

    // Agreement with @cq/config: parseReviewerToken parses the same shape.
    const parsed = parseReviewerToken("pi:grok-build/grok-build:xhigh");
    expect(parsed.harness).toBe("pi");
    expect(parsed.provider).toBe("grok-build");
    expect(parsed.model).toBe("grok-build");
    expect(parsed.effort).toBe("xhigh");
  });

  it("(b) claude:opus-4.8[1m]:high — tokenToChildModel null (parent fallback); effort recorded inertly; no --thinking, no error", () => {
    const token = replicaParseCqToken("claude:opus-4.8[1m]:high");
    expect(token).not.toBeNull();
    expect(token!.harness).toBe("claude");
    expect(token!.model).toBe("opus-4.8[1m]");
    // Effort is recorded on the token (observable / inert) ...
    expect(token!.effort).toBe("high");
    // ... but tokenToChildModel REFUSES a claude token → parent fallback.
    const child = replicaTokenToChildModel(token!);
    expect(child).toBeNull();
    // No child model args at all → the parent model is used, no effort passed.
    const modelArgs = replicaBuildModelArgs(child);
    expect(modelArgs).toEqual([]);
    expect(modelArgs).not.toContain("--thinking");

    // Agreement with @cq/config: parseReviewerToken accepts and records 'high'.
    const parsed = parseReviewerToken("claude:opus-4.8[1m]:high");
    expect(parsed.harness).toBe("claude");
    expect(parsed.model).toBe("opus-4.8[1m]");
    expect(parsed.effort).toBe("high");
  });

  it("(c) effortless pi token — child --model has NO ':<effort>' suffix", () => {
    const child = replicaParseAndConvert("pi:ollama-cloud/minimax-m3");
    expect(child).not.toBeNull();
    expect(child!.effort).toBeNull();
    const modelArgs = replicaBuildModelArgs(child);
    const modelIdx = modelArgs.indexOf("--model");
    // No ':<effort>' suffix on the --model value; provider is split out.
    expect(modelArgs[modelIdx + 1]).toBe("minimax-m3");
    expect(modelArgs[modelIdx + 1]).not.toContain(":");
    expect(modelArgs).toEqual(["--provider", "ollama-cloud", "--model", "minimax-m3"]);
    expect(modelArgs).not.toContain("--thinking");
  });

  it("(d) unsupported-effort policy is LENIENT — invalid suffix → null (parent fallback), NOT a throw", () => {
    // 'turbo' is not a pi effort. The trailing ':' is then a reserved residual
    // ':' in the model half → parseCqToken returns null (the extension's
    // lenient policy: a bad token degrades to the parent-model fallback, never
    // aborts a dispatch). This is the DOCUMENTED divergence from @cq/config,
    // which FAILS FAST (throws) at its config-load boundary.
    expect(replicaParseCqToken("pi:grok-build/grok-build:turbo")).toBeNull();
    expect(replicaParseAndConvert("pi:grok-build/grok-build:turbo")).toBeNull();
    // Same input: @cq/config throws (fail-fast at the harness boundary).
    expect(() =>
      parseReviewerToken("pi:grok-build/grok-build:turbo"),
    ).toThrow(CqConfigError);

    // An out-of-vocabulary claude effort behaves the same way (lenient null).
    // 'off' is a pi effort but NOT a claude effort → residual ':' → null.
    expect(replicaParseCqToken("claude:opus-4.8[1m]:off")).toBeNull();
    expect(() => parseReviewerToken("claude:opus-4.8[1m]:off")).toThrow(
      CqConfigError,
    );
  });

  it("(e) GPT-5.6 efforts 'max'/'none' now parse on a pi token; pi-only efforts still don't leak into claude", () => {
    // GPT-5.6 brought 'max' and 'none' into PI_EFFORTS, so they now parse as
    // valid pi efforts (the effort suffix is stripped, model half is clean).
    expect(replicaIsEffort("pi", "max")).toBe(true);
    expect(replicaIsEffort("pi", "none")).toBe(true);
    expect(replicaParseCqToken("pi:grok-build/grok-build:max")).not.toBeNull();
    expect(parseReviewerToken("pi:grok-build/grok-build:max").effort).toBe("max");
    expect(parseReviewerToken("pi:grok-build/grok-build:none").effort).toBe(
      "none",
    );
    // The partition still holds in the surviving direction: a pi-only effort
    // ('none' is not a CLAUDE_EFFORT) must not leak into a claude token.
    expect(replicaIsEffort("claude", "none")).toBe(false);
    expect(replicaParseCqToken("claude:opus-4.8[1m]:none")).toBeNull();
    expect(() => parseReviewerToken("claude:opus-4.8[1m]:none")).toThrow(
      CqConfigError,
    );
  });

  it("(f) empty trailing-colon suffix — 'pi:grok-build/grok-build:' → null (parent fallback)", () => {
    // A trailing ':' yields an empty effort candidate. isEffort('pi','') is
    // false → the ':' is not stripped → it remains a reserved residual ':' in
    // the model half → replicaParseCqToken returns null.
    expect(replicaIsEffort("pi", "")).toBe(false);
    expect(replicaParseCqToken("pi:grok-build/grok-build:")).toBeNull();
    expect(replicaParseAndConvert("pi:grok-build/grok-build:")).toBeNull();
    // Same input: @cq/config throws (fail-fast at the harness boundary).
    expect(() => parseReviewerToken("pi:grok-build/grok-build:")).toThrow(
      CqConfigError,
    );
  });
});

// ── (5) D79 (5c) extension/config effort-vocabulary PARITY test (T511) ──────
//
// Unlike the hand-typed PI_EFFORTS_REPLICA/CLAUDE_EFFORTS_REPLICA above (which
// are literals maintained BY HAND and can themselves drift from the real
// extension file), this test reads the ACTUAL SOURCE TEXT of
// nix/pkg/pi-extensions/cq-subagent-dispatch.ts and extracts its live
// `const PI_EFFORTS = new Set([...])` / `const CLAUDE_EFFORTS = new Set([...])`
// literals via a source-text regex, then asserts set-EQUALITY against
// @cq/config's exported PI_EFFORTS / CLAUDE_EFFORTS. Any future drift — the
// extension forgetting a new effort @cq/config gains, or vice versa — fails
// this test, closing the D79 gap (a pi :none/:max token validated in
// @cq/config but diverged at extension dispatch).

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../../../");
const EXTENSION_PATH = path.join(
  REPO_ROOT,
  "nix/pkg/pi-extensions/cq-subagent-dispatch.ts",
);

/**
 * Extract the string literals of a `const <name> = new Set([...]);` (or
 * `new Set<string>([...])`) declaration from raw TypeScript source text.
 * Deliberately simple (no TS parser): the extension is read as plain text
 * because it lives outside the cq-ledgers workspace and cannot be imported.
 */
function extractSetLiteral(source: string, constName: string): string[] {
  const declRe = new RegExp(
    `const\\s+${constName}\\s*=\\s*new Set(?:<[^>]*>)?\\(\\[([\\s\\S]*?)\\]\\)`,
  );
  const match = declRe.exec(source);
  if (match === null) {
    throw new Error(
      `could not find "const ${constName} = new Set([...])" in ${EXTENSION_PATH}`,
    );
  }
  const body = match[1] ?? "";
  const stringRe = /"([^"]*)"|'([^']*)'/g;
  const values: string[] = [];
  let stringMatch: RegExpExecArray | null;
  while ((stringMatch = stringRe.exec(body)) !== null) {
    values.push(stringMatch[1] ?? stringMatch[2] ?? "");
  }
  return values;
}

describe("D79 (5c) extension/@cq-config effort-vocabulary parity (T511)", () => {
  const extensionSource = readFileSync(EXTENSION_PATH, "utf8");
  const extensionPiEfforts = new Set(
    extractSetLiteral(extensionSource, "PI_EFFORTS"),
  );
  const extensionClaudeEfforts = new Set(
    extractSetLiteral(extensionSource, "CLAUDE_EFFORTS"),
  );

  it("extension PI_EFFORTS Set equals @cq/config PI_EFFORTS (no drift either way)", () => {
    const configPiEfforts = new Set<string>(PI_EFFORTS);
    expect(extensionPiEfforts).toEqual(configPiEfforts);
  });

  it("extension CLAUDE_EFFORTS Set equals @cq/config CLAUDE_EFFORTS (no drift either way)", () => {
    const configClaudeEfforts = new Set<string>(CLAUDE_EFFORTS);
    expect(extensionClaudeEfforts).toEqual(configClaudeEfforts);
  });

  it("extension PI_EFFORTS includes 'none' and 'max' (the D79 gap)", () => {
    expect(extensionPiEfforts.has("none")).toBe(true);
    expect(extensionPiEfforts.has("max")).toBe(true);
  });

  // (b) working dispatch path: pi tokens with :none / :max resolve to child
  // --model '<model>:none' / '<model>:max' — mirrors R342 emission
  // (cq-subagent-dispatch.ts L756-768) via the same replica helpers used in
  // section (4), which already carry 'none'/'max' in their literal sets.
  // DO NOT regress the existing off/minimal/low/medium/high/xhigh emission.
  const PI_MODEL_EFFORT_CASES = [
    "off",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  for (const effort of PI_MODEL_EFFORT_CASES) {
    it(`pi:ollama-cloud/minimax-m3:${effort} resolves child --model to 'minimax-m3:${effort}'`, () => {
      const token = replicaParseCqToken(`pi:ollama-cloud/minimax-m3:${effort}`);
      expect(token).not.toBeNull();
      expect(token!.effort).toBe(effort);

      const child = replicaTokenToChildModel(token!);
      expect(child).not.toBeNull();
      expect(child!.effort).toBe(effort);

      const modelArgs = replicaBuildModelArgs(child);
      const modelIdx = modelArgs.indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(modelArgs[modelIdx + 1]).toBe(`minimax-m3:${effort}`);
      expect(modelArgs).not.toContain("--thinking");
    });
  }
});
