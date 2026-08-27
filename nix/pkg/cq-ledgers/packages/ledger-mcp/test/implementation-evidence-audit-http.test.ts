import { describe, expect, test } from "bun:test";
import {
  ImplementationEvidenceService,
  InMemoryLedgerStore,
  createInMemoryImplementationEvidenceStore,
  implementationAuditManifestDigest,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationReviewerIdentity,
  type PackagedImplementationAuditManifest,
} from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";

const HEAD = "a".repeat(40);
const identity: ImplementationReviewerIdentity = {
  alias: "adapter",
  harness: "pi",
  model: "frontier",
  provider: "provider",
  effort: null,
  launch: "adapter",
  adapterId: "pi:adapter",
};
const manifest: PackagedImplementationAuditManifest = {
  version: 1,
  manifestId: "audit-http-v1",
  sourceDigest: "b".repeat(64),
  records: [
    {
      recordKey: "T50",
      taskRef: "tasks:T50",
      ownerGoalRef: "goals:G1",
      finalizedManifest: "manifest",
      historicalReview: null,
      baseCommit: "c".repeat(40),
      resultCommit: "d".repeat(40),
      repositoryHead: HEAD,
      diff: "diff",
      acceptance: "acceptance",
      gateObservations: { exitCode: 0, passCount: 1 },
      requiredObservations: ["commit-retained"],
    },
  ],
  activation: null,
};

function evidenceService(): ImplementationEvidenceService {
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store: createInMemoryImplementationEvidenceStore(),
    resolveReviewerRoster: () => [identity],
    resolveAuditRoster: () => [identity],
    nativeFallback: { ...identity, launch: "native", adapterId: "pi:native" },
    prepareNativeReview: async () => {
      throw new Error("not configured");
    },
    fetchNativeReview: async () => ({ state: "missing" }),
    executeExternalReview: async () => {
      throw new Error("not configured");
    },
    fetchWorker: async () => ({ state: "missing" }),
    readTaskAuthority: async (taskRef) => ({
      taskRef,
      ownerGoalRef: "goals:G1",
      status: "done",
      finalizedManifest: "manifest",
    }),
    repositoryHead: async () => HEAD,
    verifyImplementation: async () => {
      throw new Error("not configured");
    },
    recordLedgerCompletion: async () => {
      throw new Error("not configured");
    },
    readAuditManifest: async () => structuredClone(manifest),
    isCommitRetained: async () => true,
  };
  return new ImplementationEvidenceService(dependencies);
}

function textPayload(result: unknown): unknown {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("implementation audit HTTP response contained no text payload");
  }
  return JSON.parse(first.text);
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
  const response = await handlers.handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice(5)
    .trim();
  return { response, message: JSON.parse(data ?? text) as Record<string, unknown> };
}

describe("implementation audit HTTP transport [Blackbox-GoodCommunication]", () => {
  test("exposes protected audit operations only to authenticated management sessions", async () => {
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    const handlers = attachMcpHttp(
      ledger,
      "implementation-audit-http",
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
      evidenceService(),
    );
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "implementation-audit-http", version: "0.0.1" },
      },
    };
    const ordinaryInitialized = await rpc(handlers, initialize, undefined, "ordinary");
    const ordinarySessionId = ordinaryInitialized.response.headers.get("mcp-session-id");
    if (ordinarySessionId === null) throw new Error("ordinary initialization returned no session id");
    const ordinaryTools = await rpc(
      handlers,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ordinarySessionId,
      "ordinary",
    );
    expect(
      (ordinaryTools.message["result"] as { tools: Array<{ name: string }> }).tools.some(
        (tool) => tool.name === "prepare_implementation_audit_panel",
      ),
    ).toBe(false);

    const initialized = await rpc(handlers, initialize, undefined, "management");
    const sessionId = initialized.response.headers.get("mcp-session-id");
    if (sessionId === null) throw new Error("management initialization returned no session id");
    const called = await rpc(
      handlers,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "prepare_implementation_audit_panel",
          arguments: {
            manifest_id: manifest.manifestId,
            manifest_digest: implementationAuditManifestDigest(manifest),
            record_key: "T50",
            expected_repository_head: HEAD,
            operation_id: "panel-http",
            author: "parent",
          },
        },
      },
      sessionId,
      "management",
    );
    expect(called.response.status).toBe(200);
    expect(textPayload(called.message["result"])).toMatchObject({
      status: "prepared",
      manifestId: manifest.manifestId,
      taskRef: "tasks:T50",
    });
  });
});
