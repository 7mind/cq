/**
 * T1962 — coordination-bundle contract module load + shared suite entry.
 */

import { describe, expect, it } from "bun:test";
import {
  createInMemoryWorksetOwnedGuardedLedger,
  createTrustedWorksetManagementAuthority,
} from "../src/index.js";
import { runWorksetCoordinationBundleContract } from "./worksetCoordinationBundleContract.js";

runWorksetCoordinationBundleContract({
  name: "in-memory-dummy",
  classification: "Behavioral-Active Blackbox-Atomic",
  build: (options) =>
    createInMemoryWorksetOwnedGuardedLedger({
      ...options,
      invocationAuthority: createTrustedWorksetManagementAuthority(),
    }),
});

describe("workset coordination-bundle contract module [T1962]", () => {
  it("exports a runnable contract entry point", () => {
    expect(typeof runWorksetCoordinationBundleContract).toBe("function");
  });
});
