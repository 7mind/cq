import { materializeOperatorAction } from "../src/index.js";
import { DIRECT_OPERATOR_INPUT, seedDirectOwnedTasks } from "./directOwnedLifecycleContract.js";
import { registerLifecycleProjectionFaults } from "./lifecycleCoherenceFixture.js";
import { LIFECYCLE_NOW, LIFECYCLE_PROVENANCE } from "./sqlitePlanLifecycleFixture.js";

for (const operation of ["acknowledge", "record-evidence", "revise", "complete"] as const) {
  registerLifecycleProjectionFaults(`operator ${operation}`, async ({ store }) => {
    await seedDirectOwnedTasks(store);
    await materializeOperatorAction(store, DIRECT_OPERATOR_INPUT);
    const acknowledge = { kind: "acknowledge", actionId: "OA1", expectedRevision: 1, outputIdentity: "direct-identity", acknowledgedAt: LIFECYCLE_NOW } as const;
    const evidence = { kind: "record-evidence", actionId: "OA1", expectedRevision: 1,
      evidence: { command: "probe", stdout: "ready", stderr: "", exitCode: 0, outputIdentity: "direct-identity", observedAt: LIFECYCLE_NOW }, provenance: LIFECYCLE_PROVENANCE } as const;
    if (operation === "acknowledge") return { invoke: () => store.mutateOperatorAction(acknowledge), documents: ["operatorActions:OA1"], privateKeys: [] };
    await store.mutateOperatorAction(acknowledge);
    if (operation === "record-evidence") return { invoke: () => store.mutateOperatorAction(evidence), documents: ["operatorActions:OA1"], privateKeys: [] };
    if (operation === "revise") return { invoke: () => store.mutateOperatorAction({ kind: "revise", actionId: "OA1", expectedRevision: 1,
      expectedOutputIdentity: "identity-2", expectedEvidence: ["probe-2"], revisedAt: LIFECYCLE_NOW, provenance: LIFECYCLE_PROVENANCE }),
      documents: ["operatorActions:OA1", "tasks:T1", "handoffs:HO1"], privateKeys: [] };
    await store.mutateOperatorAction(evidence);
    return { invoke: () => store.mutateOperatorAction({ kind: "complete", actionId: "OA1", expectedRevision: 1, completion: "verified", provenance: LIFECYCLE_PROVENANCE }),
      documents: ["operatorActions:OA1", "tasks:T1"], privateKeys: [] };
  });
}
