import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseConfig, resolveAgentModel, type ReviewerToken } from "@cq/config";
import {
  getFinalOutput,
  parseChildJsonEvent,
  parseFlatToml,
  resolveAgentToken,
  resolveDispatchConfig,
  type CqToken,
} from "./cq-subagent-dispatch/index.ts";

describe("Pi subagent JSON output [BA]", () => {
  test("preserves message_end assistant text as the final output", () => {
    const message = parseChildJsonEvent(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
          provider: "openai-codex",
          model: "gpt-5.6-sol",
        },
      }),
    );

    expect(message).not.toBeNull();
    expect(getFinalOutput(message === null ? [] : [message])).toBe("first\nsecond");
  });

  test("accepts tool_result_end and ignores malformed or unrelated records", () => {
    expect(
      parseChildJsonEvent(
        JSON.stringify({ type: "tool_result_end", message: { role: "toolResult" } }),
      ),
    ).toEqual({ role: "toolResult" });
    expect(parseChildJsonEvent("not-json")).toBeNull();
    expect(parseChildJsonEvent(JSON.stringify({ type: "turn_start" }))).toBeNull();
  });

  test("delegates cancellation to process-control without ChildProcess.killed or timers", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./cq-subagent-dispatch/index.ts", import.meta.url)),
      "utf8",
    );
    // Process seam remains for forceShellout / cross-harness (T1699).
    expect(source).toContain("launchPiChildSeam(");
    // Same-harness forceShellout=false uses createAgentSession via native session.
    expect(source).toContain("runPiNativeDelivery");
    expect(source).toContain("executePiChildDeliveryBranch");
    expect(source).toContain("PI_NATIVE_SESSION_SEAM");
    expect(source).not.toContain("proc.killed");
    expect(source).not.toContain("proc.kill(");
    expect(source).not.toContain("setTimeout(");
  });
});

describe("cq config dispatch boundary [SA]", () => {
  test("uses the merged cq config command before the single-file fallback", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./cq-subagent-dispatch/index.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain('execFile("cq", ["config"]');
    expect(source).toContain('configSource: "cli" | "file" | "none"');
  });
});

describe("merged dispatch config resolution [BA]", () => {
  const cliPayloadValue = {
    configured: true,
    tiers: {
      standard: {
        harness: "pi",
        model: "grok-build",
        provider: "grok-build",
        effort: "high",
      },
      frontier: {
        harness: "claude",
        model: "opus-4.8[1m]",
        provider: null,
        effort: "xhigh",
      },
    },
    agentTiers: { "implement-worker": "standard", "plan-reviewer": "frontier" },
    agentEfforts: { "implement-worker": "low" },
  } as const;
  const cliPayload = JSON.stringify(cliPayloadValue);

  test("uses the merged CLI payload and applies the per-agent effort", async () => {
    let fileReads = 0;
    const result = await resolveDispatchConfig("/repo", "/repo/cq.toml", "implement-worker", "pi", {
      runCqConfig: async (cwd) => {
        expect(cwd).toBe("/repo");
        return cliPayload;
      },
      readConfigFile: () => {
        fileReads += 1;
        return "";
      },
    });

    expect(result).toEqual({
      configSource: "cli",
      resolvedTier: "standard",
      token: { harness: "pi", model: "grok-build/grok-build", effort: "low" },
    });
    expect(fileReads).toBe(0);
  });

  test("keeps configured:true authoritative when its tier cannot drive pi", async () => {
    let fileReads = 0;
    const result = await resolveDispatchConfig("/repo", "/repo/cq.toml", "missing-agent", "pi", {
      runCqConfig: async () => JSON.stringify({ ...cliPayloadValue, tiers: null }),
      readConfigFile: () => {
        fileReads += 1;
        return BASE;
      },
    });

    expect(result).toEqual({ configSource: "cli", resolvedTier: "standard", token: null });
    expect(fileReads).toBe(0);
  });

  test("keeps parseable configured:true authoritative when its payload is invalid", async () => {
    let fileReads = 0;
    const result = await resolveDispatchConfig("/repo", "/repo/cq.toml", "implement-worker", "pi", {
      runCqConfig: async () => JSON.stringify({ configured: true, tiers: "invalid" }),
      readConfigFile: () => {
        fileReads += 1;
        return BASE;
      },
    });

    expect(result).toEqual({ configSource: "cli", resolvedTier: null, token: null });
    expect(fileReads).toBe(0);
  });

  test.each([
    ["unconfigured", async () => JSON.stringify({ configured: false })],
    ["malformed JSON", async () => "not-json"],
    ["command failure", async () => Promise.reject(new Error("cq config exited 1"))],
  ])("falls back to the pinned file when CLI config is %s", async (_name, runCqConfig) => {
    const result = await resolveDispatchConfig("/repo", "/explicit/cq.toml", "implement-worker", "pi", {
      runCqConfig,
      readConfigFile: (configPath) => {
        expect(configPath).toBe("/explicit/cq.toml");
        return BASE;
      },
    });

    expect(result).toEqual({
      configSource: "file",
      resolvedTier: "standard",
      token: { harness: "pi", model: "grok-build/grok-build", effort: "high" },
    });
  });

  test("maps an invalid CLI effort to the parent fallback without reading the file", async () => {
    const result = await resolveDispatchConfig("/repo", "/repo/cq.toml", "plan-reviewer", "pi", {
      runCqConfig: async () =>
        JSON.stringify({
          ...cliPayloadValue,
          agentEfforts: { "plan-reviewer": "off" },
        }),
      readConfigFile: () => {
        throw new Error("authoritative CLI config must not fall back");
      },
    });

    expect(result).toEqual({ configSource: "cli", resolvedTier: "frontier", token: null });
  });

  test("returns none when both config boundaries fail", async () => {
    const result = await resolveDispatchConfig("/repo", "/repo/cq.toml", "implement-worker", "pi", {
      runCqConfig: async () => Promise.reject(new Error("spawn failed")),
      readConfigFile: () => {
        throw new Error("missing file");
      },
    });
    expect(result).toEqual({ configSource: "none", resolvedTier: null, token: null });
  });
});

// ---------------------------------------------------------------------------
// [agent_efforts] equivalence (T2001 / D209, Q254).
//
// The extension's INLINED resolver (parseFlatToml + resolveAgentToken) must
// apply [agent_efforts] with the SAME semantics as the canonical
// resolveAgentModel in @cq/config (parseConfig + applyAgentEffort): the
// override wins over the tier token's `:<effort>` suffix (including when the
// suffix is absent), an absent entry is a no-op, and an effort invalid for the
// RESOLVED harness is rejected. The extension CANNOT import @cq/config at
// RUNTIME (standalone store-path file), but a TEST may — mirroring the
// existing @cq/process-control import in cq-subagent-process-lifecycle.test.ts
// (tsconfig `paths` + the node_modules/@cq symlink staged by the
// pi-extensions-tests flake check).
//
// The single sanctioned divergence is the FAILURE MODE: @cq/config fails fast
// (throws CqConfigError) at its config-load boundary; the inlined mirror is
// pinned LENIENT (see parseCqToken's UNSPECIFIED-EFFORT POLICY) and resolves
// to null so the caller degrades to the parent session's model. The invalid-
// override case below pins exactly that mapping: canonical THROW <=> mirror
// NULL.
// ---------------------------------------------------------------------------

/** The canonical fixture, mirrored verbatim from @cq/config's agent-efforts.test.ts. */
const BASE = [
  "[aliases]",
  '  opus  = "claude:opus-4.8[1m]:xhigh"',
  '  haiku = "claude:haiku"',
  '  grok  = "pi:grok-build/grok-build:high"',
  "",
  "[tiers]",
  '  frontier = "opus"',
  '  standard = "grok"',
  '  fast     = "haiku"',
  "",
  "[agent_tiers]",
  '  plan-reviewer    = "frontier"',
  '  implement-worker = "standard"',
].join("\n");

/** Normalize a canonical ReviewerToken to the mirror's CqToken shape. */
function normalizeCanonical(token: ReviewerToken): CqToken {
  return {
    harness: token.harness,
    model: token.provider !== null ? `${token.provider}/${token.model}` : token.model,
    effort: token.effort ?? null,
  };
}

/** Canonical side: parseConfig + resolveAgentModel for `harness`. */
function canonicalResolve(source: string, agent: string, harness: "claude" | "pi"): CqToken {
  return normalizeCanonical(resolveAgentModel(parseConfig(source, harness), agent));
}

/** Mirror side: parseFlatToml + resolveAgentToken for `harness`. */
function mirrorResolve(source: string, agent: string, harness: "claude" | "pi"): CqToken | null {
  return resolveAgentToken(parseFlatToml(source), agent, harness);
}

describe("[agent_efforts] mirror/canonical equivalence (D209, Q254)", () => {
  const CASES: Array<{ name: string; source: string; agent: string; harness: "claude" | "pi" }> = [
    {
      name: "override wins over an explicit tier-token effort (:xhigh -> :max)",
      source: `${BASE}\n[agent_efforts]\n  plan-reviewer = "max"\n`,
      agent: "plan-reviewer",
      harness: "claude",
    },
    {
      name: "sets the effort on a tier token that has NO effort suffix",
      source: `${BASE.replace('implement-worker = "standard"', 'implement-worker = "fast"')}\n[agent_efforts]\n  implement-worker = "low"\n`,
      agent: "implement-worker",
      harness: "claude",
    },
    {
      name: "applies to a DEFAULT_TIER agent (no [agent_tiers] entry, pi token)",
      source: `${BASE}\n[agent_efforts]\n  investigate-prober = "low"\n`,
      agent: "investigate-prober",
      harness: "claude",
    },
    {
      name: "absent [agent_efforts] entry leaves the tier token effort unchanged",
      source: `${BASE}\n[agent_efforts]\n  plan-reviewer = "max"\n`,
      agent: "implement-worker",
      harness: "claude",
    },
    {
      name: "absent [agent_efforts] table leaves the tier token effort unchanged",
      source: BASE,
      agent: "plan-reviewer",
      harness: "claude",
    },
    {
      name: "accepts a pi-only effort for a pi-resolved agent ('off')",
      source: `${BASE}\n[agent_efforts]\n  implement-worker = "off"\n`,
      agent: "implement-worker",
      harness: "claude",
    },
    {
      name: "applies on top of a per-harness [harness.pi.tiers] override",
      source: `${BASE}\n[harness.pi.tiers]\n  standard = "haiku"\n\n[agent_efforts]\n  implement-worker = "medium"\n`,
      agent: "implement-worker",
      harness: "pi",
    },
  ];

  for (const { name, source, agent, harness } of CASES) {
    test(name, () => {
      const mirror = mirrorResolve(source, agent, harness);
      expect(mirror).not.toBeNull();
      expect(mirror).toEqual(canonicalResolve(source, agent, harness));
    });
  }

  test("an effort invalid for the RESOLVED harness: canonical THROWS, mirror returns null", () => {
    // "off" is a legal pi effort, so the canonical PARSE accepts it; the
    // plan-reviewer resolves to a claude token, where "off" is illegal — the
    // canonical resolveAgentModel throws CqConfigError. The lenient mirror
    // maps that same rejection to null (parent-model fallback).
    const source = `${BASE}\n[agent_efforts]\n  plan-reviewer = "off"\n`;
    expect(() => canonicalResolve(source, "plan-reviewer", "claude")).toThrow(
      /agent_efforts\["plan-reviewer"\] = "off" is not a valid effort for harness "claude"/,
    );
    expect(mirrorResolve(source, "plan-reviewer", "claude")).toBeNull();
  });

  test("parses [agent_efforts] into the subset ({} when absent)", () => {
    expect(parseFlatToml(`${BASE}\n[agent_efforts]\n  plan-reviewer = "max"\n`).agentEfforts).toEqual({
      "plan-reviewer": "max",
    });
    expect(parseFlatToml(BASE).agentEfforts).toEqual({});
  });
});
