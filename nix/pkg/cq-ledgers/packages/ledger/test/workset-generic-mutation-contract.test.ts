/**
 * T1961 — contract module load + shared suite entry (in-memory leg also runs
 * via workset-generic-mutation-inmemory.test.ts).
 *
 * This file re-exports the abstract suite runner and pins the contract
 * surface so discovery (`bun test …contract.test.ts`) loads the module.
 */

import { describe, expect, it } from "bun:test";
import {
  WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES,
  WORKSET_GENERIC_MUTATION_FIELD_CLAUSES,
  createInMemoryWorksetManagementLedger,
} from "../src/index.js";
import {
  runWorksetGenericMutationContract,
  type WorksetGenericMutationContractFactory,
} from "./worksetGenericMutationContract.js";

describe("workset generic-mutation contract module [T1961]", () => {
  it("exports a non-empty operation and field inventory for the shared suite", () => {
    expect(WORKSET_GENERIC_MUTATION_OPERATION_CLAUSES.length).toBeGreaterThan(0);
    expect(WORKSET_GENERIC_MUTATION_FIELD_CLAUSES.length).toBeGreaterThan(0);
  });

  it("builds the in-memory guarded ledger factory shape", async () => {
    const factory: WorksetGenericMutationContractFactory = {
      name: "in-memory-smoke",
      classification: "Behavioral-Active Blackbox-Atomic",
      build: () => createInMemoryWorksetManagementLedger(),
    };
    const ledger = await factory.build();
    await ledger.init();
    expect(ledger.mutations.form).toBe("workset-generic-mutation-gateway");
    expect(await ledger.snapshotRoots()).toEqual({ roots: [], epoch: 0 });
  });
});

// Always run the full shared suite against the in-memory dummy from this file
// as well, so `bun test …contract.test.ts` alone is sufficient for the
// Behavioral-Active Blackbox core (inmemory.test.ts is the dual-tests leg).
runWorksetGenericMutationContract({
  name: "in-memory",
  classification: "Behavioral-Active Blackbox-Atomic",
  build: (options) => createInMemoryWorksetManagementLedger(options),
});
