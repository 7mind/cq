/** T1981: RemoteLedgerClient forwards every typed plan-lifecycle operation exactly once. */

import { afterEach, describe, expect, it } from "bun:test";
import {
  RemoteLedgerClient,
  type PlanClaimResult,
  type PlanFinalizeResult,
  type PlanPublishDraftResult,
  type PlanReleaseResult,
  type WorksetPlanLifecycleMutationKind,
} from "../src/index.js";
import {
  EXCLUDED_CLAIM,
  EXCLUDED_FINALIZE,
  EXCLUDED_PUBLISH,
  EXCLUDED_RELEASE,
  excludedPlanResult,
} from "./worksetPlanLifecycleMcpSupport.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

function operationForTool(name: string): WorksetPlanLifecycleMutationKind {
  switch (name) {
    case "claim_plan":
      return "claim-plan";
    case "publish_plan_draft":
      return "publish-plan-draft";
    case "release_plan_claim":
      return "release-plan-claim";
    case "finalize_plan":
      return "finalize-plan";
    default:
      throw new Error(`unexpected plan lifecycle tool ${name}`);
  }
}

function installPlanLifecycleProbe(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "GET") return new Response("not offered", { status: 405 });
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    const body = (await request.json()) as {
      readonly id?: string | number | null;
      readonly method?: string;
      readonly params?: {
        readonly protocolVersion?: string;
        readonly name?: string;
        readonly arguments?: Record<string, unknown>;
      };
    };
    if (body.method?.startsWith("notifications/") === true) {
      return new Response(null, { status: 202 });
    }
    const headers = {
      "content-type": "application/json",
      "mcp-session-id": "t1981-remote-session",
    };
    if (body.method === "tools/call") {
      if (body.params?.name === undefined || body.params.arguments === undefined) {
        throw new Error("tools/call omitted its name or arguments");
      }
      calls.push({ name: body.params.name, arguments: body.params.arguments });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(excludedPlanResult(operationForTool(body.params.name))),
              },
            ],
          },
        }),
        { status: 200, headers },
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "t1981-remote-probe", version: "0.0.1" },
        },
      }),
      { status: 200, headers },
    );
  }) as typeof fetch;
  return calls;
}

describe("RemoteLedgerClient workset-guarded plan lifecycle [Behavioral-Active Blackbox-Group]", () => {
  it("correlates and forwards the four public requests without serialized context", async () => {
    const calls = installPlanLifecycleProbe();
    const remote = await RemoteLedgerClient.connect({
      serverUrl: "http://ledger.invalid",
      projectKey: "t1981",
      token: "ordinary-token",
    });
    try {
      const claimed: PlanClaimResult = await remote.claimPlan(EXCLUDED_CLAIM);
      const published: PlanPublishDraftResult = await remote.publishPlanDraft(EXCLUDED_PUBLISH);
      const released: PlanReleaseResult = await remote.releasePlanClaim(EXCLUDED_RELEASE);
      const finalized: PlanFinalizeResult = await remote.finalizePlan(EXCLUDED_FINALIZE);

      expect(claimed).toEqual(excludedPlanResult("claim-plan"));
      expect(published).toEqual(excludedPlanResult("publish-plan-draft"));
      expect(released).toEqual(excludedPlanResult("release-plan-claim"));
      expect(finalized).toEqual(excludedPlanResult("finalize-plan"));
      expect(calls).toEqual([
        { name: "claim_plan", arguments: EXCLUDED_CLAIM },
        { name: "publish_plan_draft", arguments: EXCLUDED_PUBLISH },
        { name: "release_plan_claim", arguments: EXCLUDED_RELEASE },
        { name: "finalize_plan", arguments: EXCLUDED_FINALIZE },
      ]);
      for (const call of calls) {
        expect(call.arguments).not.toHaveProperty("workset");
        expect(call.arguments).not.toHaveProperty("admission");
        expect(call.arguments).not.toHaveProperty("authority");
      }
    } finally {
      await remote.close();
    }
  });
});
