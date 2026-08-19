import { describe, expect, test } from "bun:test";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { recordUpstreamIssues } from "../src/recordUpstreamIssues.js";
import { UPSTREAM_LEDGER } from "../src/constants.js";

describe("T823/T824 recordUpstreamIssues", () => {
  test("creates ordinary records on the upstream ledger [BA]", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const items = await recordUpstreamIssues(store, [
      {
        headline: "rejects valid input",
        package: "example",
        reportingClassification: "ordinary",
        trackerKind: "github",
        sourceRefs: ["defects:D1"],
      },
    ]);
    expect(items).toHaveLength(1);
    const fetched = store.fetchItem(UPSTREAM_LEDGER, items[0]!.id);
    expect(fetched.status).toBe("open");
    expect(fetched.fields["package"]).toBe("example");
    expect(fetched.fields["reportingClassification"]).toBe("ordinary");
    await store.dispose();
  });
});
