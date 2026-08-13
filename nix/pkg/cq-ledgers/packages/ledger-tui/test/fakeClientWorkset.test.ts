import { describe, expect, it } from "bun:test";
import { runWorksetClientContract } from "@cq/ledger/testing/worksetClientContract";
import { FakeClient } from "./fakeClient.js";

runWorksetClientContract({
  name: "ledger-tui FakeClient",
  classification: "Behavioral-Active Blackbox-Atomic",
  build() {
    const client = new FakeClient();
    return { client, close: async () => client.close() };
  },
});

describe("ledger-tui FakeClient workset controls", () => {
  it("records immutable requests and exposes deferred failure hooks", async () => {
    const client = new FakeClient();
    let release = (): void => undefined;
    client.worksetDeferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const roots = ["T1"];
    const pending = client.workset({ op: "fetch", roots, projection: "id" });
    roots[0] = "T2";
    expect(client.worksetCalls).toEqual([
      { op: "fetch", roots: ["T1"], projection: "id" },
    ]);
    release();
    await pending;

    client.worksetDeferred = null;
    client.worksetFailure = new Error("deferred workset failure");
    await expect(client.workset({ op: "get", projection: "id" })).rejects.toThrow(
      "deferred workset failure",
    );
  });
});
