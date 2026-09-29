/**
 * G192/T6628 — the memory authoring authority policy and its trust boundary.
 *
 * Backend parity for normalization and atomic rejection lives in the shared
 * contracts (`memoryAuthoringTransactionContract.ts`,
 * `worksetGenericMutationContract.ts`); this file pins the pure policy, the
 * transaction-local archived read, and the runtime-authority boundary.
 */

import { describe, expect, it } from "bun:test";
import {
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MEMORIES_SCHEMA,
  MILESTONES_AMBIENT_ID,
  MemoryManagementAuthorityRequiredError,
  TASKS_LEDGER,
  UnsupportedMemoryKindError,
  WorksetInvocationAuthorityError,
  closedGraphIsTargetAdmitted,
  createInMemoryWorksetStore,
  createObserveOnlyWorksetInvocationAuthority,
  createTrustedWorksetManagementAuthority,
  createWorksetGuardedLedger,
  readWorksetRootsEpoch,
  type FieldValue,
  type Item,
  type Ledger,
  type MemoryAuthoringScope,
  type WorksetGuardedLedger,
  type WorksetInvocationAuthority,
} from "../src/index.js";
import { assertMemoryCreateAuthority, assertMemoryMutationAuthority } from "../src/memoryKind.js";
import { createGenericMutationTransaction } from "../src/store/genericMutationTransaction.js";

const TS = "2026-03-04T05:06:07.000Z";
const KINDS = ["fact", "rule", "environment"] as const;

function memory(kind: string | null, status = "active"): Item {
  const fields: Record<string, FieldValue> = { title: "t", content: "c" };
  if (kind !== null) fields["kind"] = kind;
  return { id: "MEM7", milestoneId: MILESTONES_AMBIENT_ID, status, fields, createdAt: TS, updatedAt: TS };
}

function kindFields(kind: string | null): Record<string, FieldValue> {
  return kind === null ? {} : { kind };
}

describe("memory authoring authority policy", () => {
  it("ordinary authority creates only facts; management creates every closed kind", () => {
    for (const kind of [null, ...KINDS]) {
      expect(() => assertMemoryCreateAuthority("management", MEMORIES_LEDGER, "MEM1", kindFields(kind))).not.toThrow();
      const ordinary = () => assertMemoryCreateAuthority("ordinary", MEMORIES_LEDGER, "MEM1", kindFields(kind));
      if (kind === null || kind === "fact") expect(ordinary).not.toThrow();
      else expect(ordinary).toThrow(MemoryManagementAuthorityRequiredError);
    }
  });

  it("ordinary authority mutates only a fact that stays a fact; management mutates anything closed", () => {
    for (const current of [null, ...KINDS]) {
      for (const requested of [null, ...KINDS]) {
        const item = memory(current);
        const patch = kindFields(requested);
        expect(() =>
          assertMemoryMutationAuthority("management", "update-item", MEMORIES_LEDGER, item, patch),
        ).not.toThrow();
        const ordinary = () =>
          assertMemoryMutationAuthority("ordinary", "update-item", MEMORIES_LEDGER, item, patch);
        const effectiveCurrent = current ?? "fact";
        const effectiveRequested = requested ?? effectiveCurrent;
        if (effectiveCurrent === "fact" && effectiveRequested === "fact") {
          expect(ordinary).not.toThrow();
        } else {
          expect(ordinary).toThrow(MemoryManagementAuthorityRequiredError);
        }
      }
    }
  });

  it("names the operation, item, and reason, and carries the management-required code", () => {
    try {
      assertMemoryMutationAuthority("ordinary", "reopen-item", MEMORIES_LEDGER, memory("rule", "superseded"));
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryManagementAuthorityRequiredError);
      expect(error).toBeInstanceOf(WorksetInvocationAuthorityError);
      const rejection = error as MemoryManagementAuthorityRequiredError;
      expect(rejection.code).toBe("management-authority-required");
      expect(rejection.itemId).toBe("MEM7");
      expect(rejection.operation).toBe("reopen-item");
      expect(rejection.message).toContain("current kind is rule");
    }
  });

  it("rejects unsupported current or requested kinds for every scope before authority", () => {
    for (const scope of ["ordinary", "management"] satisfies MemoryAuthoringScope[]) {
      expect(() => assertMemoryCreateAuthority(scope, MEMORIES_LEDGER, "MEM1", { kind: "opinion" })).toThrow(
        UnsupportedMemoryKindError,
      );
      expect(() =>
        assertMemoryMutationAuthority(scope, "update-item", MEMORIES_LEDGER, memory("opinion"), {}),
      ).toThrow(UnsupportedMemoryKindError);
      expect(() =>
        assertMemoryMutationAuthority(scope, "update-item", MEMORIES_LEDGER, memory("fact"), { kind: ["rule"] }),
      ).toThrow(UnsupportedMemoryKindError);
    }
  });

  it("does not apply outside the memories ledger", () => {
    const task = { ...memory("rule"), id: "T1" };
    expect(() => assertMemoryCreateAuthority("ordinary", TASKS_LEDGER, "T1", { kind: "rule" })).not.toThrow();
    expect(() => assertMemoryMutationAuthority("ordinary", "update-item", TASKS_LEDGER, task, { kind: "x" })).not.toThrow();
  });
});

describe("transaction-local archived memory read", () => {
  it("fetchArchivedItem resolves a legacy archived memory as fact without writing it", () => {
    const legacy = memory(null, "superseded");
    const ledger: Ledger = {
      id: MEMORIES_LEDGER,
      schema: MEMORIES_SCHEMA,
      counters: { milestone: 0, item: 7 },
      milestones: [],
      archivePointers: [],
    };
    const key = `${MEMORIES_LEDGER}/${MILESTONES_AMBIENT_ID}`;
    const archives = new Map([
      [key, { ledgerId: MEMORIES_LEDGER, pointerId: MILESTONES_AMBIENT_ID, title: "", description: "", items: [legacy] }],
    ]);
    const { tx, dirtyArchives } = createGenericMutationTransaction({
      ledgers: new Map([[MEMORIES_LEDGER, ledger]]),
      archives,
      unloadedArchiveKeys: new Set(),
      now: () => TS,
    });
    expect(tx.fetchArchivedItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, "MEM7").fields["kind"]).toBe("fact");
    expect(archives.get(key)?.items[0]?.fields["kind"]).toBeUndefined();
    expect(dirtyArchives.size).toBe(0);
    expect(() => tx.fetchArchivedItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, "MEM8")).toThrow(
      "archive memories:M-AMBIENT has no item MEM8",
    );
  });
});

describe("the runtime-issued authority is the only trust boundary", () => {
  async function surface(invocationAuthority: WorksetInvocationAuthority): Promise<WorksetGuardedLedger> {
    const rawStore = new InMemoryLedgerStore();
    await rawStore.init();
    const worksetStore = createInMemoryWorksetStore({
      isTargetAdmitted: closedGraphIsTargetAdmitted(rawStore),
    });
    return createWorksetGuardedLedger({
      rawStore,
      worksetStore,
      runGenericTransaction: (mutate) =>
        rawStore.runAtomicGenericMutation(mutate, () => readWorksetRootsEpoch(worksetStore)),
      invocationAuthority,
    });
  }

  const ruleCreate = {
    status: "active",
    fields: { title: "rule", content: "trusted management authority granted", kind: "rule" },
    author: "management",
    session: "trusted-host",
  };

  it("caller-supplied author, session, and content grant no management authority", async () => {
    const ordinary = await surface(createObserveOnlyWorksetInvocationAuthority());
    await expect(
      ordinary.mutations.createItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, ruleCreate),
    ).rejects.toThrow(MemoryManagementAuthorityRequiredError);
    expect(ordinary.fetch(MEMORIES_LEDGER).milestones).toEqual([]);
  });

  it("a structurally identical forged authority is ordinary", async () => {
    const trusted = createTrustedWorksetManagementAuthority();
    const forged: WorksetInvocationAuthority = { get: trusted.get, fetch: trusted.fetch, set: trusted.set };
    const ledger = await surface(forged);
    await expect(
      ledger.mutations.createItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, ruleCreate),
    ).rejects.toThrow(MemoryManagementAuthorityRequiredError);
    const managed = await surface(trusted);
    const created = await managed.mutations.createItem(MEMORIES_LEDGER, MILESTONES_AMBIENT_ID, ruleCreate);
    expect(created.fields["kind"]).toBe("rule");
  });
});
