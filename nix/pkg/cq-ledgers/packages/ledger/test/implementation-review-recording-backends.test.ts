import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  createFsImplementationEvidenceStore,
  createInMemoryImplementationEvidenceStore,
  type ImplementationEvidenceStore,
} from "../src/index.js";
import { createImplementationEvidenceFixture } from "./implementationEvidenceTestSupport.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

async function contract(store: ImplementationEvidenceStore): Promise<void> {
  const fixture = await createImplementationEvidenceFixture(store);
  const snapshot = await store.snapshot();
  expect(snapshot.panels[fixture.panel.panelRef]?.attemptRefs).toEqual([fixture.attemptRef]);
  expect(snapshot.attempts[fixture.attemptRef]?.terminalState).toBe("approved");
}

describe("implementation evidence store adapters [Behavioral-Active Blackbox-Atomic]", () => {
  test("runs the shared contract against the in-memory dummy", async () => {
    await contract(createInMemoryImplementationEvidenceStore());
  });

  // regression: R1489 — protected authority was one replaceable JSON snapshot.
  test("persists authenticated append-only records and survives reconstruction [Behavioral-Active Effectual-GoodCommunication]", async () => {
    const root = await fs.mkdtemp("/tmp/cq-t2345-evidence-");
    temporaryRoots.push(root);
    const path = join(root, "implementation-evidence.journal");
    await contract(createFsImplementationEvidenceStore({ path }));

    const entries = (await fs.readdir(path)).sort();
    expect(entries).toHaveLength(3);
    const records = await Promise.all(
      entries.map(async (entry) =>
        JSON.parse(await fs.readFile(join(path, entry), "utf8")) as Record<string, unknown>,
      ),
    );
    expect(records.map((record) => record["kind"])).toEqual([
      "cq-implementation-evidence-journal-entry",
      "cq-implementation-evidence-journal-entry",
      "cq-implementation-evidence-journal-entry",
    ]);
    expect(records.map((record) => record["sequence"])).toEqual([1, 2, 3]);
    expect(records.map((record) => record["priorDigest"])).toEqual([
      null,
      records[0]?.["digest"],
      records[1]?.["digest"],
    ]);

    const reopened = createFsImplementationEvidenceStore({ path });
    expect(Object.keys((await reopened.snapshot()).panels)).toHaveLength(1);
  });
});
