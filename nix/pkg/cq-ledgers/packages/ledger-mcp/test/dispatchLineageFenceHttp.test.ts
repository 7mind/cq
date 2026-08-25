import { afterEach, describe, expect, test } from "bun:test";
import {
  InMemoryLedgerStore,
  createDispatchLineageCutoverFence,
  journalRecoveryRequiredForFence,
  type DispatchCapability,
} from "@cq/ledger";
import { attachMcpHttp } from "../src/main.js";

const stores: InMemoryLedgerStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});

function resultText(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
  const first = result.content[0];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error("expected one JSON text response");
  }
  return first.text;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const data = body
    .split(/\r?\n/u)
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(data ?? body) as Record<string, unknown>;
}

describe("dispatch lineage fence HTTP response", () => {
  test("prepare_dispatch serializes only typed public refusal references", async () => {
    const fence = createDispatchLineageCutoverFence({
      namespace: { backend: "xdg", projectKey: "http-fence" },
      taskId: "T2816",
      managedFingerprint: "1".repeat(64),
      sourceAttestationId: `att_${"a".repeat(32)}`,
      selectedSourceGeneration: 4,
      lineageMaximumGeneration: 7,
      recoverySeedRef: `cq-current-recovery-seal:v1:${"2".repeat(64)}`,
      fenceCapability: {
        scope: "dispatch-lineage-fence",
        token: "http-fence-secret-capability",
      },
      installedAt: "2026-08-25T06:00:00.000Z",
    });
    const refusal = journalRecoveryRequiredForFence(fence);
    const unavailable = async (): Promise<never> => {
      throw new Error("unexpected dispatch operation");
    };
    const dispatchCapability: DispatchCapability = {
      prepare: async () => refusal,
      fetchInput: unavailable,
      storeResult: unavailable,
      confirmCompletion: unavailable,
      abort: unavailable,
      fetch: unavailable,
    };
    const store = new InMemoryLedgerStore();
    await store.init();
    stores.push(store);
    const handlers = attachMcpHttp(
      store,
      "dispatch fence HTTP",
      "",
      undefined,
      "http-fence",
      undefined,
      undefined,
      dispatchCapability,
    );
    const post = async (body: unknown, sessionId?: string): Promise<Response> =>
      await handlers.handle(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
          },
          body: JSON.stringify(body),
        }),
      );
    const initialized = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "dispatch-fence-http", version: "0.0.1" },
      },
    });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();
    await responseJson(initialized);
    const ready = await post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId!,
    );
    expect(ready.status).toBe(202);
    await ready.text();
    const call = await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "prepare_dispatch",
          arguments: {
            roleId: "implement-worker",
            input: { taskId: "T2816" },
            idempotencyKey: "fenced-http-prepare",
            timeoutMs: 600_000,
            expectedChild: { childId: "child", runId: "run" },
          },
        },
      },
      sessionId!,
    );
    expect(call.status).toBe(200);
    const envelope = await responseJson(call);
    const response = (envelope["result"] as {
      readonly content: readonly { readonly type: string; readonly text?: string }[];
    });
    expect(resultText(response)).toBe(JSON.stringify(refusal));
    const encoded = resultText(response);
    expect(encoded).not.toContain(fence.sourceAttestationId);
    expect(encoded).not.toContain(fence.recoverySeedRef);
    expect(encoded).not.toContain(fence.fenceCapabilityHash);
  });
});
