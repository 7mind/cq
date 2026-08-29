import { describe, expect, test } from "bun:test";
import { InMemoryLedgerStore, type ImplementationEvidenceService } from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";

const FROM_HEAD = "a".repeat(40);
const REPOSITORY_HEAD = "b".repeat(40);
const PRIOR_REQUIREMENT_REF =
  `cq-implementation-evidence-activation-requirement:v1:${"1".repeat(64)}`;
const COMPLETION_REF = `cq-implementation-completion:v1:${"2".repeat(64)}`;

function service(): ImplementationEvidenceService {
  return {
    continueEvidenceActivation: async () => ({
      status: "continued",
      continuationRef: `cq-implementation-evidence-activation-continuation:v1:${"3".repeat(64)}`,
      previousRequirementRef: PRIOR_REQUIREMENT_REF,
      requirementRef:
        `cq-implementation-evidence-activation-requirement:v1:${"4".repeat(64)}`,
      activationRef: `cq-implementation-evidence-activation:v1:${"5".repeat(64)}`,
      taskRef: "tasks:T3003",
      completionRef: COMPLETION_REF,
      fromHead: FROM_HEAD,
      repositoryHead: REPOSITORY_HEAD,
    }),
  } as unknown as ImplementationEvidenceService;
}

async function rpc(
  handlers: ReturnType<typeof attachMcpHttp>,
  body: Record<string, unknown>,
  sessionId: string | undefined,
  token: string,
): Promise<{ response: Response; message: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (sessionId !== undefined) headers["mcp-session-id"] = sessionId;
  const response = await handlers.handle(new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice(5)
    .trim();
  return { response, message: JSON.parse(data ?? text) as Record<string, unknown> };
}

function textPayload(result: unknown): unknown {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string")
    throw new Error("continuation HTTP response contained no text payload");
  return JSON.parse(first.text);
}

describe("implementation evidence continuation HTTP [Blackbox-GoodCommunication]", () => {
  test("requires an authenticated management session", async () => {
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const handlers = attachMcpHttp(
      ledger,
      "implementation-continuation-http",
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "full",
      undefined,
      { ordinaryToken: "ordinary", managementToken: "management" },
      "observe",
      false,
      service(),
    );
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "continuation-http", version: "1.0.0" },
      },
    };
    const ordinary = await rpc(handlers, initialize, undefined, "ordinary");
    const ordinarySession = ordinary.response.headers.get("mcp-session-id");
    if (ordinarySession === null) throw new Error("ordinary session id is absent");
    const ordinaryTools = await rpc(
      handlers,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ordinarySession,
      "ordinary",
    );
    expect(
      (ordinaryTools.message["result"] as { tools: Array<{ name: string }> }).tools.some(
        ({ name }) => name === "continue_implementation_evidence_activation",
      ),
    ).toBe(false);

    const management = await rpc(handlers, initialize, undefined, "management");
    const managementSession = management.response.headers.get("mcp-session-id");
    if (managementSession === null) throw new Error("management session id is absent");
    const called = await rpc(
      handlers,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "continue_implementation_evidence_activation",
          arguments: {
            goal_ref: "goals:G176",
            manifest_id: "d347-implementation-evidence-activation-v2",
            prior_requirement_ref: PRIOR_REQUIREMENT_REF,
            completed_task_ref: "tasks:T3003",
            completion_ref: COMPLETION_REF,
            expected_from_head: FROM_HEAD,
            expected_repository_head: REPOSITORY_HEAD,
            operation_id: "continue-http",
            author: "parent",
          },
        },
      },
      managementSession,
      "management",
    );
    expect(called.response.status).toBe(200);
    expect(textPayload(called.message["result"])).toMatchObject({
      status: "continued",
      previousRequirementRef: PRIOR_REQUIREMENT_REF,
      taskRef: "tasks:T3003",
      fromHead: FROM_HEAD,
      repositoryHead: REPOSITORY_HEAD,
    });
  });
});
