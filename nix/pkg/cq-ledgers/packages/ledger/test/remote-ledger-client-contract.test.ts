/**
 * T727 RemoteLedgerClient — the dual contract registration (both legs) plus
 * the pure unit coverage of the endpoint derivation (remoteMcpUrl), which
 * needs no service at all (Behavioral-Active Blackbox-Atomic).
 */

import { describe, expect, it } from "bun:test";
import {
  RemoteLedgerClient,
  RemoteLedgerClientConfigError,
  RemoteManagementScopeError,
  remoteMcpUrl,
  type WorksetResult,
} from "../src/index.js";
import { runRemoteLedgerClientContract } from "./remoteLedgerClientContract.js";
import { inMemoryRemoteClientFactory } from "./remoteLedgerClientInMemoryAdapter.js";
import { postgresRemoteClientFactory } from "./remoteLedgerClientPostgresAdapter.js";

describe("remoteMcpUrl (BA)", () => {
  it("derives /p/<encoded projectKey>/mcp from the serverUrl origin", () => {
    expect(remoteMcpUrl("http://127.0.0.1:5190/", "proj-1")).toBe(
      "http://127.0.0.1:5190/p/proj-1/mcp",
    );
    // A trailing path on serverUrl is replaced wholesale (Q283).
    expect(remoteMcpUrl("http://127.0.0.1:5190", "proj-1")).toBe(
      "http://127.0.0.1:5190/p/proj-1/mcp",
    );
    expect(remoteMcpUrl("https://hub.example.com:8443/ignored/path", "proj-1")).toBe(
      "https://hub.example.com:8443/p/proj-1/mcp",
    );
  });

  it("percent-encodes the projectKey as a single path segment", () => {
    expect(remoteMcpUrl("http://h/", "key with spaces/and:separators")).toBe(
      "http://h/p/key%20with%20spaces%2Fand%3Aseparators/mcp",
    );
  });

  it("rejects a non-HTTP(S) serverUrl with RemoteLedgerClientConfigError", () => {
    expect(() => remoteMcpUrl("ws://hub.example.com/", "p")).toThrow(
      RemoteLedgerClientConfigError,
    );
  });

  it("rejects a non-absolute serverUrl (TypeError from new URL)", () => {
    expect(() => remoteMcpUrl("not-a-url", "p")).toThrow(TypeError);
  });
});

describe("RemoteLedgerClient workset scope (Behavioral-Active Blackbox-Atomic)", () => {
  it("correlates each request discriminant with its result at compile time", () => {
    const assertCorrelation = (remote: RemoteLedgerClient): void => {
      const get: Promise<Extract<WorksetResult, { op: "get" }>> = remote.workset({
        op: "get",
        projection: "id",
      });
      const fetch: Promise<Extract<WorksetResult, { op: "fetch" }>> = remote.workset({
        op: "fetch",
        roots: [],
        projection: "compact",
      });
      const set: Promise<Extract<WorksetResult, { op: "set" }>> = remote.workset({
        op: "set",
        roots: [],
      });
      void [get, fetch, set];
    };
    expect(typeof assertCorrelation).toBe("function");
  });

  it("rejects ordinary set locally without issuing a request", async () => {
    let requests = 0;
    const remote = Object.assign(Object.create(RemoteLedgerClient.prototype), {
      _scope: "ordinary",
      endpoint: "http://example.invalid/p/project/mcp",
      client: {
        callTool: async () => {
          requests += 1;
          throw new Error("must not issue a request");
        },
      },
    }) as RemoteLedgerClient;
    await expect(remote.workset({ op: "set", roots: [] })).rejects.toBeInstanceOf(
      RemoteManagementScopeError,
    );
    expect(requests).toBe(0);
  });

  it("keeps protected implementation evidence management-bound with typed client parity", async () => {
    const calls: string[] = [];
    const remote = Object.assign(Object.create(RemoteLedgerClient.prototype), {
      _scope: "ordinary",
      endpoint: "http://example.invalid/p/project/mcp",
      client: {
        callTool: async ({ name }: { name: string }) => {
          calls.push(name);
          return { content: [{ type: "text", text: "{}" }] };
        },
      },
    }) as RemoteLedgerClient;
    await expect(
      remote.prepareImplementationReviewPanel({
        taskRef: "tasks:T2345",
        resultCommit: "b".repeat(40),
        workerDispatch: { attestationId: "att_worker", generation: 1 },
        operationId: "panel",
        author: "parent",
      }),
    ).rejects.toBeInstanceOf(RemoteManagementScopeError);
    expect(calls).toEqual([]);

    Object.assign(remote, { _scope: "management" });
    await remote.prepareImplementationReviewPanel({
      taskRef: "tasks:T2345",
      resultCommit: "b".repeat(40),
      workerDispatch: { attestationId: "att_worker", generation: 1 },
      operationId: "panel",
      author: "parent",
    });
    expect(calls).toEqual(["prepare_implementation_review_panel"]);
    expect(
      [
        "prepareImplementationReviewAttempt",
        "executeExternalImplementationReviewAttempt",
        "finalizeImplementationReviewAttempt",
        "prepareImplementationReviewFallback",
        "prepareImplementationCompletion",
        "recordImplementationCompletion",
      ].every((name) => typeof (remote as unknown as Record<string, unknown>)[name] === "function"),
    ).toBe(true);
  });
});

runRemoteLedgerClientContract(inMemoryRemoteClientFactory);
runRemoteLedgerClientContract(postgresRemoteClientFactory);
