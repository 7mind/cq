import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseConfig, resolveAgentModel, type ReviewerToken } from "@cq/config";
import {
  getFinalOutput,
  parseChildJsonEvent,
  parseFlatToml,
  resolveAgentToken,
  type CqToken,
} from "./cq-subagent-dispatch.ts";

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
      fileURLToPath(new URL("./cq-subagent-dispatch.ts", import.meta.url)),
      "utf8",
    );
    // Process seam remains for forceShellout / cross-harness (T1699).
    expect(source).toContain("await launchPiChild(");
    // Same-harness forceShellout=false uses createAgentSession via native session.
    expect(source).toContain("runPiNativeSession");
    expect(source).toContain("PI_NATIVE_SESSION_SEAM");
    expect(source).not.toContain("proc.killed");
    expect(source).not.toContain("proc.kill(");
    expect(source).not.toContain("setTimeout(");
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
