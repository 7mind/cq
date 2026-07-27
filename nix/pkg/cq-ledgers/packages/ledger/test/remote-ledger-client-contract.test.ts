/**
 * T727 RemoteLedgerClient — the dual contract registration (both legs) plus
 * the pure unit coverage of the endpoint derivation (remoteMcpUrl), which
 * needs no service at all (Behavioral-Active Blackbox-Atomic).
 */

import { describe, expect, it } from "bun:test";
import {
  RemoteLedgerClientConfigError,
  remoteMcpUrl,
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

runRemoteLedgerClientContract(inMemoryRemoteClientFactory);
runRemoteLedgerClientContract(postgresRemoteClientFactory);
