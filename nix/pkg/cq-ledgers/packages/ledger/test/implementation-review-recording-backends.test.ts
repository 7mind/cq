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

  test("runs the shared contract against durable storage and survives reconstruction", async () => {
    const root = await fs.mkdtemp("/tmp/cq-t2345-evidence-");
    temporaryRoots.push(root);
    const path = join(root, "implementation-evidence.json");
    await contract(createFsImplementationEvidenceStore({ path }));
    const reopened = createFsImplementationEvidenceStore({ path });
    expect(Object.keys((await reopened.snapshot()).panels)).toHaveLength(1);
  });
});
