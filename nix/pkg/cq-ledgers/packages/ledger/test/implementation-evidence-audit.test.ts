import { describe, expect, test } from "bun:test";
import { createInMemoryImplementationEvidenceStore } from "../src/index.js";

describe("protected historical implementation evidence [BA]", () => {
  test("starts with distinct append-only audit and activation collections", async () => {
    const snapshot = await createInMemoryImplementationEvidenceStore().snapshot();

    expect(snapshot).toMatchObject({
      version: 1,
      auditPanels: {},
      auditAttempts: {},
      implementationAudits: {},
      activationRequirements: {},
      activations: {},
    });
  });
});
