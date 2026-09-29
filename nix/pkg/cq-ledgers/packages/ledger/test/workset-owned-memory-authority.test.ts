/**
 * G192/T6629 — owned-write memory authoring authority over the public
 * owned-ledger constructors. The per-adapter transaction cases (including the
 * in-transaction interleaving) live in `runWorksetOwnedWriteContract`.
 */

import { describe, expect, it } from "bun:test";
import {
  InMemoryLedgerStore,
  MEMORIES_LEDGER,
  MemoryManagementAuthorityRequiredError,
  UnsupportedMemoryKindError,
  closedGraphIsTargetAdmitted,
  createInMemoryWorksetGuardedPlanLifecycleStore,
  createInMemoryWorksetOwnedGuardedLedger,
  createInMemoryWorksetStore,
  createObserveOnlyWorksetInvocationAuthority,
  createTrustedWorksetManagementAuthority,
  createWorksetOwnedGuardedLedger,
  createWorksetOwnedWriteGateway,
  type OwnerlessCreateInput,
  type WorksetInvocationAuthority,
  type WorksetOwnedGuardedLedger,
  type WorksetOwnedWriteGateway,
} from "../src/index.js";

function memoryInput(title: string, kind: string | undefined): OwnerlessCreateInput {
  return {
    ledgerId: MEMORIES_LEDGER,
    status: "active",
    fields: { title, content: `${title} body`, ...(kind === undefined ? {} : { kind }) },
  };
}

/** A caller-built object with the authority shape but no runtime issuance. */
const CALLER_MINTED_AUTHORITY: WorksetInvocationAuthority = Object.freeze({
  get: <T>(operation: () => T): T => operation(),
  fetch: async <T>(operation: () => Promise<T> | T): Promise<T> => await operation(),
  set: async <T>(operation: () => Promise<T> | T): Promise<T> => await operation(),
});

async function expectOrdinaryOnly(
  owned: WorksetOwnedWriteGateway,
  observe: () => Promise<unknown>,
): Promise<void> {
  for (const kind of ["rule", "environment"] as const) {
    const before = await observe();
    await expect(owned.createOwnerless(memoryInput(`ordinary ${kind}`, kind))).rejects.toThrow(
      MemoryManagementAuthorityRequiredError,
    );
    expect(await observe()).toEqual(before);
  }
  const before = await observe();
  await expect(owned.createOwnerless(memoryInput("ordinary note", "note"))).rejects.toThrow(
    UnsupportedMemoryKindError,
  );
  expect(await observe()).toEqual(before);
  const omitted = await owned.createOwnerless(memoryInput("ordinary omitted", undefined));
  const explicit = await owned.createOwnerless(memoryInput("ordinary explicit", "fact"));
  expect([omitted.fields.kind, explicit.fields.kind]).toEqual(["fact", "fact"]);
}

function observeLedger(ledger: WorksetOwnedGuardedLedger): () => Promise<unknown> {
  return async () => ({
    physical: await ledger.exportPhysicalLedgerState(),
    roots: await ledger.snapshotRoots(),
    admissions: ledger.activeAdmissionCount(),
  });
}

describe("owned-write memory authoring authority [G192/T6629]", () => {
  it("inventories every owned-write entry point that can target memories", () => {
    const ledger = createInMemoryWorksetOwnedGuardedLedger();
    expect(Object.keys(ledger.owned).sort()).toEqual(["createOwned", "createOwnerless", "form"]);
    expect(Object.keys(ledger.bundles).sort()).toEqual([
      "bootstrapDefectToFixGoal",
      "bootstrapIdeaToGoal",
      "form",
    ]);
  });

  describe("createInMemoryWorksetOwnedGuardedLedger", () => {
    const ordinaryOptions: ReadonlyArray<readonly [string, WorksetInvocationAuthority | undefined]> = [
      ["default authority", undefined],
      ["explicit observe-only authority", createObserveOnlyWorksetInvocationAuthority()],
      ["caller-minted authority lookalike", CALLER_MINTED_AUTHORITY],
    ];
    for (const [label, invocationAuthority] of ordinaryOptions) {
      it(`${label} is ordinary under empty roots`, async () => {
        const ledger = createInMemoryWorksetOwnedGuardedLedger(
          invocationAuthority === undefined ? {} : { invocationAuthority },
        );
        await ledger.init();
        expect((await ledger.snapshotRoots()).roots).toEqual([]);
        await expectOrdinaryOnly(ledger.owned, observeLedger(ledger));
      });
    }

    it("trusted management authority creates rule and environment memories", async () => {
      const ledger = createInMemoryWorksetOwnedGuardedLedger({
        invocationAuthority: createTrustedWorksetManagementAuthority(),
      });
      await ledger.init();
      await ledger.setRoots([]);
      const rule = await ledger.owned.createOwnerless(memoryInput("managed rule", "rule"));
      const environment = await ledger.owned.createOwnerless(
        memoryInput("managed environment", "environment"),
      );
      expect([rule.fields.kind, environment.fields.kind]).toEqual(["rule", "environment"]);
      await expect(
        ledger.owned.createOwnerless(memoryInput("managed note", "note")),
      ).rejects.toThrow(UnsupportedMemoryKindError);
    });
  });

  describe("createWorksetOwnedGuardedLedger", () => {
    function host(invocationAuthority: WorksetInvocationAuthority | undefined) {
      const rawStore = new InMemoryLedgerStore();
      return {
        rawStore,
        worksetStore: createInMemoryWorksetStore({
          isTargetAdmitted: closedGraphIsTargetAdmitted(rawStore),
        }),
        ...(invocationAuthority === undefined ? {} : { invocationAuthority }),
        runOwnedTransaction: <T>(
          mutate: Parameters<InMemoryLedgerStore["runAtomicOwnedMutation"]>[0],
          context: Parameters<InMemoryLedgerStore["runAtomicOwnedMutation"]>[1],
        ) => rawStore.runAtomicOwnedMutation(mutate, context) as Promise<T>,
      };
    }

    it("a host without an authority defaults to observe-only (ordinary)", async () => {
      const ledger = createWorksetOwnedGuardedLedger(host(undefined));
      await ledger.init();
      await expectOrdinaryOnly(ledger.owned, observeLedger(ledger));
    });

    it("a caller-minted authority lookalike stays ordinary", async () => {
      const ledger = createWorksetOwnedGuardedLedger(host(CALLER_MINTED_AUTHORITY));
      await ledger.init();
      await expectOrdinaryOnly(ledger.owned, observeLedger(ledger));
    });

    it("management authority binds to owned writes", async () => {
      const ledger = createWorksetOwnedGuardedLedger(
        host(createTrustedWorksetManagementAuthority()),
      );
      await ledger.init();
      const rule = await ledger.owned.createOwnerless(memoryInput("bound rule", "rule"));
      expect(rule.fields.kind).toBe("rule");
    });
  });

  it("the bare owned-write gateway without an authority is ordinary", async () => {
    const rawStore = new InMemoryLedgerStore();
    await rawStore.init();
    const owned = createWorksetOwnedWriteGateway({
      rawStore,
      worksetStore: createInMemoryWorksetStore({
        isTargetAdmitted: closedGraphIsTargetAdmitted(rawStore),
      }),
      runOwnedTransaction: (mutate, context) => rawStore.runAtomicOwnedMutation(mutate, context),
    });
    await expectOrdinaryOnly(owned, async () => ({
      memories: rawStore.fetch(MEMORIES_LEDGER),
    }));
  });

  it("the guarded plan-lifecycle store inherits the ordinary owned default", async () => {
    const store = createInMemoryWorksetGuardedPlanLifecycleStore();
    await store.init();
    await expect(store.owned.createOwnerless(memoryInput("plan rule", "rule"))).rejects.toThrow(
      MemoryManagementAuthorityRequiredError,
    );
    expect(store.fetch(MEMORIES_LEDGER).counters.item).toBe(0);
  });
});
