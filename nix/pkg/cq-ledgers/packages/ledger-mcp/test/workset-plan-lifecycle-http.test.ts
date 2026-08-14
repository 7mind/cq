/** T1981: every HTTP plan-lifecycle tool enters through workset admission. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "bun:test";
import {
  GOALS_LEDGER,
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  type PlanClaimInput,
  type PlanFinalizeInput,
  type PlanPublishDraftInput,
  type PlanReleaseInput,
  type WorksetPlanLifecycleMutationKind,
} from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";

const OWNER_FENCE_TOKEN = "t1981_owner_fence_token_0001";
const PROVENANCE = { author: "t1981", session: "t1981-http" } as const;

const CLAIM: PlanClaimInput = {
  goalId: "G1",
  purpose: "initial",
  expectedGeneration: null,
  claimRequestId: "t1981-http-claim",
  ownerFenceToken: OWNER_FENCE_TOKEN,
  ...PROVENANCE,
};

const PUBLISH: PlanPublishDraftInput = {
  goalId: "G1",
  claimId: "claim-G1-1",
  generation: 1,
  operationId: "t1981-http-publish",
  ownerFenceToken: OWNER_FENCE_TOKEN,
  manifest: {
    milestones: [{ key: "delivery", title: "Excluded delivery" }],
    tasks: [{ key: "task", milestoneKey: "delivery", headline: "Excluded task" }],
  },
  ...PROVENANCE,
};

const RELEASE: PlanReleaseInput = {
  kind: "abandon",
  goalId: "G1",
  claimId: "claim-G1-1",
  generation: 1,
  operationId: "t1981-http-release",
  reason: "excluded recovery",
  ...PROVENANCE,
};

const FINALIZE: PlanFinalizeInput = {
  goalId: "G1",
  claimId: "claim-G1-1",
  generation: 1,
  operationId: "t1981-http-finalize",
  ownerFenceToken: OWNER_FENCE_TOKEN,
  reviewId: "R1",
  draftRevision: 1,
  decision: { headline: "Excluded decision" },
  ...PROVENANCE,
};

function textPayload(result: unknown): string {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("plan lifecycle HTTP response contained no text payload");
  }
  return first.text;
}

describe("workset-guarded plan lifecycle — HTTP MCP [Behavioral-Active Blackbox-GoodCommunication]", () => {
  it("rejects all four excluded operations before changing the goal", async () => {
    const store = new InMemoryLedgerStore();
    await store.init();
    for (const goalId of ["G1", "G2"] as const) {
      await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
        id: goalId,
        status: "clarifying",
        fields: { title: goalId, description: `${goalId} description` },
        ...PROVENANCE,
      });
    }
    await store.worksetStore().setRoots(["goals:G2"]);

    const handlers = attachMcpHttp(store, "t1981-http", "");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handlers.handle(request),
    });
    const client = new Client(
      { name: "t1981-http-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(server.port)}/mcp`),
      ) as unknown as Transport,
    );

    const cases: ReadonlyArray<{
      readonly tool: string;
      readonly operation: WorksetPlanLifecycleMutationKind;
      readonly input: PlanClaimInput | PlanPublishDraftInput | PlanReleaseInput | PlanFinalizeInput;
    }> = [
      { tool: "claim_plan", operation: "claim-plan", input: CLAIM },
      { tool: "publish_plan_draft", operation: "publish-plan-draft", input: PUBLISH },
      { tool: "release_plan_claim", operation: "release-plan-claim", input: RELEASE },
      { tool: "finalize_plan", operation: "finalize-plan", input: FINALIZE },
    ];

    try {
      for (const { tool, operation, input } of cases) {
        const result = await client.callTool({ name: tool, arguments: { ...input } });
        expect(JSON.parse(textPayload(result)), tool).toEqual({
          ok: false,
          conflict: {
            code: "workset-conflict",
            operation,
            reason: "target-excluded",
            goalId: "G1",
            refs: ["goals:G1"],
            epoch: 1,
          },
        });
        expect(store.fetchItem(GOALS_LEDGER, "G1").status).toBe("clarifying");
      }
    } finally {
      await client.close();
      await server.stop(true);
      await store.dispose();
    }
  });
});
