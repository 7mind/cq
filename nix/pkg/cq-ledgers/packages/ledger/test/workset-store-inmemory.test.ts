/**
 * T1954 — in-memory WorksetStore dummy specifics.
 *
 * The shared Blackbox suite lives in workset-store-contract.test.ts. This file
 * locks dummy-only properties: structural coordinator compatibility, that
 * durable state is roots+epoch only (no graph/materialized closure), and that
 * the store surface does not smuggle filesystem/SQL concerns.
 */

import { describe, expect, it } from "bun:test";
import {
  createInMemoryWorksetAdmissionCoordinator,
  createInMemoryWorksetStore,
  readWorksetRootsEpoch,
  worksetStoreFromCoordinator,
  type WorksetStore,
} from "../src/index.js";

describe("workset store in-memory dummy [T1954]", () => {
  it("createInMemoryWorksetStore returns a WorksetStore", async () => {
    const store: WorksetStore = createInMemoryWorksetStore();
    expect(await readWorksetRootsEpoch(store)).toEqual({ roots: [], epoch: 0 });
    expect(typeof store.setRoots).toBe("function");
    expect(typeof store.admitLedgerMutation).toBe("function");
    expect(typeof store.admitExternalEffect).toBe("function");
    expect(typeof store.runAdministrative).toBe("function");
    expect(typeof store.activeAdmissionCount).toBe("function");
    expect(typeof store.exclusiveHeld).toBe("function");
  });

  it("worksetStoreFromCoordinator adapts a T1953 coordinator without wrapping state", async () => {
    const coordinator = createInMemoryWorksetAdmissionCoordinator();
    await coordinator.setRoots(["goals:G1"]);
    const store = worksetStoreFromCoordinator(coordinator);
    expect(await readWorksetRootsEpoch(store)).toEqual({
      roots: ["goals:G1"],
      epoch: 1,
    });
    // Mutations through the store view hit the same coordinator state.
    await store.setRoots(["tasks:T1"]);
    expect(coordinator.snapshot()).toEqual({ roots: ["tasks:T1"], epoch: 2 });
  });

  it("persists only roots and epoch — no graph/closure fields on the snapshot", async () => {
    const store = createInMemoryWorksetStore();
    const snap = await store.setRoots(["milestones:M1", "tasks:T2"]);
    expect(Object.keys(snap).sort()).toEqual(["epoch", "roots"]);
    expect(snap).toEqual({ roots: ["milestones:M1", "tasks:T2"], epoch: 1 });
    const reread = await readWorksetRootsEpoch(store);
    expect(Object.keys(reread).sort()).toEqual(["epoch", "roots"]);
  });

  it("dummy source surface has no filesystem or SQL knobs", () => {
    const store = createInMemoryWorksetStore() as unknown as Record<string, unknown>;
    for (const forbidden of [
      "db",
      "database",
      "sql",
      "sqlite",
      "postgres",
      "pool",
      "path",
      "dir",
      "file",
      "fs",
      "lockfile",
      "notify",
      "listen",
    ]) {
      expect(store[forbidden], `unexpected store field "${forbidden}"`).toBeUndefined();
    }
  });
});
