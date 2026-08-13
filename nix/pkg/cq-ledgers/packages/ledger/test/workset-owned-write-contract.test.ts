/**
 * T1962 — contract module load + shared suite entry (in-memory leg also runs
 * via workset-owned-write-inmemory.test.ts).
 */

import { describe, expect, it } from "bun:test";
import {
  WORKSET_OWNED_WRITE_CREATION_KINDS,
  defaultChildLedgerForCreationKind,
  PLANNING_LIFECYCLE_CREATION_KINDS,
  IMPLEMENTATION_LIFECYCLE_CREATION_KINDS,
  createTrustedWorksetManagementAuthority,
} from "../src/index.js";
import { runWorksetOwnedWriteContract } from "./worksetOwnedWriteContract.js";
import { createInMemoryWorksetOwnedGuardedLedger } from "../src/index.js";

runWorksetOwnedWriteContract({
  name: "in-memory-dummy",
  classification: "Behavioral-Active Blackbox-Atomic",
  build: (options) =>
    createInMemoryWorksetOwnedGuardedLedger({
      ...options,
      invocationAuthority: createTrustedWorksetManagementAuthority(),
    }),
});

describe("workset owned-write contract module [T1962]", () => {
  it("inventories every planning + implementation creation kind", () => {
    const covered = new Set<string>(WORKSET_OWNED_WRITE_CREATION_KINDS);
    for (const k of PLANNING_LIFECYCLE_CREATION_KINDS) {
      expect(covered.has(k)).toBe(true);
    }
    for (const k of IMPLEMENTATION_LIFECYCLE_CREATION_KINDS) {
      expect(covered.has(k)).toBe(true);
    }
    for (const k of WORKSET_OWNED_WRITE_CREATION_KINDS) {
      expect(defaultChildLedgerForCreationKind(k)).toBeDefined();
    }
  });
});
