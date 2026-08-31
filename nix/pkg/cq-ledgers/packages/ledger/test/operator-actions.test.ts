import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  LedgerError,
  MILESTONES_AMBIENT_ID,
  OperatorActionConflictError,
  OperatorActionEnvelopeError,
  SqliteLedgerStore,
  acknowledgeOperatorAction,
  completeOperatorActionTask,
  derivePredicates,
  materializeOperatorAction,
  operatorActionRevision,
  parseOperatorActionEnvelope,
  recordOperatorActionEvidence,
  reviseOperatorAction,
  supersedeOperatorAction,
  type LedgerStore,
  type Item,
  type PlanLifecycleStore,
  type PlanDraftManifest,
  type WorksetOwnedWriteTx,
} from "../src/index.js";
import { atomicWrite as productionAtomicWrite } from "../src/store/fsAtomic.js";

const NOW = "2026-08-11T06:00:00.000Z";
const IDENTITY = "/nix/store/exact-cq";
const dirs: string[] = [];

interface OperatorActionTriple {
  readonly action: Item;
  readonly task: Item;
  readonly handoff: Item;
}

function fetchOperatorActionTriple(
  store: LedgerStore,
  actionId: string,
  taskId: string,
  handoffId: string,
): OperatorActionTriple {
  return {
    action: store.fetchItem("operatorActions", actionId),
    task: store.fetchItem("tasks", taskId),
    handoff: store.fetchItem("handoffs", handoffId),
  };
}

function expectCoherentOldOrNew<T>(actual: T, oldState: T, newState: T): "old" | "new" {
  if (isDeepStrictEqual(actual, oldState)) return "old";
  expect(actual).toEqual(newState);
  return "new";
}

function materializedPairState(store: LedgerStore) {
  return {
    actions: store
      .fetch("operatorActions")
      .milestones.flatMap(({ items }) => items)
      .map(({ id, status }) => ({ id, status })),
    handoffs: store
      .fetch("handoffs")
      .milestones.flatMap(({ items }) => items)
      .map(({ id, status }) => ({ id, status })),
  };
}

function revisedTriple(before: OperatorActionTriple): OperatorActionTriple {
  const next = structuredClone(before);
  const historicalAction = structuredClone(before.action);
  delete historicalAction.fields["revisionHistory"];
  next.action.status = "pending";
  next.action.fields["revisionHistory"] = [
    JSON.stringify({
      revision: 1,
      action: historicalAction,
      task: before.task,
      handoff: before.handoff,
    }),
  ];
  next.action.fields["revision"] = "2";
  next.action.fields["expectedOutputIdentity"] = "/nix/store/revision-2";
  next.action.fields["expectedEvidence"] = ["probe-v2"];
  for (const field of [
    "acknowledgedOutputIdentity",
    "acknowledgedAt",
    "acknowledgementEpoch",
    "evidence",
    "lastFailure",
    "verifiedAt",
    "verifiedRevision",
    "completion",
  ]) {
    delete next.action.fields[field];
  }
  next.action.author = "parent";
  next.action.updatedAt = NOW;
  next.task.status = "planned";
  delete next.task.fields["completion"];
  next.task.author = "parent";
  next.task.updatedAt = NOW;
  next.handoff.status = "user-action-required";
  next.handoff.fields["summary"] =
    `Operator action ${before.action.id} revision 2 awaits deployment identity ` +
    "/nix/store/revision-2";
  next.handoff.fields["handoffReasons"] = [
    `Deploy /nix/store/revision-2 and acknowledge ${before.action.id} revision 2`,
  ];
  next.handoff.author = "parent";
  next.handoff.updatedAt = NOW;
  return next;
}

function completedTriple(before: OperatorActionTriple): OperatorActionTriple {
  const next = structuredClone(before);
  next.action.fields["completion"] = "verified completion";
  next.action.author = "parent";
  next.action.updatedAt = NOW;
  next.task.status = "done";
  next.task.fields["completion"] = "verified completion";
  next.task.author = "parent";
  next.task.updatedAt = NOW;
  return next;
}

function mutableStoredItem(store: InMemoryLedgerStore, ledgerId: string, itemId: string): Item {
  const state = store as unknown as {
    ledgers: Map<string, { milestones: Array<{ items: Item[] }> }>;
  };
  const item = state.ledgers
    .get(ledgerId)
    ?.milestones.flatMap(({ items }) => items)
    .find(({ id }) => id === itemId);
  if (item === undefined) throw new Error(`stored item ${ledgerId}:${itemId} is unavailable`);
  return item;
}

test("accepts the goal-prefixed operator action key used by deployment tasks", () => {
  expect(
    parseOperatorActionEnvelope(
      "CQ-OPERATOR-ACTION v1 G121-deployed-recovery. User deploys; parent measures.",
    ),
  ).toEqual({ version: "v1", actionKey: "G121-deployed-recovery" });
});

interface StoreFactory {
  readonly name: string;
  build(): Promise<LedgerStore>;
}

const factories: StoreFactory[] = [
  {
    name: "in-memory",
    async build() {
      const store = new InMemoryLedgerStore({ now: () => NOW });
      await store.init();
      return store;
    },
  },
  {
    name: "filesystem",
    async build() {
      const root = await mkdtemp(path.join(tmpdir(), "cq-operator-action-fs-"));
      dirs.push(root);
      const store = new FsLedgerStore({ root, now: () => NOW });
      await store.init();
      return store;
    },
  },
  {
    name: "sqlite",
    async build() {
      const root = await mkdtemp(path.join(tmpdir(), "cq-operator-action-sqlite-"));
      dirs.push(root);
      const store = new SqliteLedgerStore({ dbPath: path.join(root, "ledger.db"), now: () => NOW });
      await store.init();
      return store;
    },
  },
];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("operator-action materialization commits only the complete action/handoff pair", async () => {
  const store = new InMemoryLedgerStore({ now: () => NOW });
  await store.init();
  try {
    const milestone = await store.createMilestone({ title: "atomic materialization" });
    const goal = await store.createItem("goals", milestone.id, {
      status: "planned",
      fields: { title: "goal", description: "goal" },
    });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "deploy",
        description:
          "CQ-OPERATOR-ACTION v1 activate-implementation-evidence. User deploys; parent measures.",
        ledgerRefs: [`goals:${goal.id}`],
      },
    });
    const atomicStore = store as InMemoryLedgerStore & {
      runAtomicOwnedMutation<T>(
        mutate: (tx: WorksetOwnedWriteTx) => T | Promise<T>,
      ): Promise<T>;
    };
    const injectedFailure = new Error("injected handoff create failure");
    const faultedStore = new Proxy(atomicStore, {
      get(target, property) {
        if (property === "createItem") {
          return async (...args: Parameters<LedgerStore["createItem"]>) => {
            if (args[0] === "handoffs") throw injectedFailure;
            return await target.createItem(...args);
          };
        }
        if (property === "runAtomicOwnedMutation") {
          return async <T>(mutate: (tx: WorksetOwnedWriteTx) => T | Promise<T>): Promise<T> =>
            await target.runAtomicOwnedMutation((tx) =>
              mutate(
                new Proxy(tx, {
                  get(txTarget, txProperty) {
                    if (txProperty === "createItemOwnerless") {
                      return (
                        ...args: Parameters<WorksetOwnedWriteTx["createItemOwnerless"]>
                      ) => {
                        if (args[0] === "handoffs") throw injectedFailure;
                        return txTarget.createItemOwnerless(...args);
                      };
                    }
                    const value = Reflect.get(txTarget, txProperty, txTarget) as unknown;
                    return typeof value === "function" ? value.bind(txTarget) : value;
                  },
                }),
              ),
            );
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LedgerStore;

    await expect(
      materializeOperatorAction(faultedStore, {
        taskId: task.id,
        expectedOutputIdentity: IDENTITY,
        expectedEvidence: ["cq ledger implementation-evidence status --json"],
        author: "parent",
      }),
    ).rejects.toBe(injectedFailure);
    expect(() => store.fetchItem("operatorActions", "OA1")).toThrow();
    expect(() => store.fetchItem("handoffs", "HO1")).toThrow();

    const created = await materializeOperatorAction(store, {
      taskId: task.id,
      expectedOutputIdentity: IDENTITY,
      expectedEvidence: ["cq ledger implementation-evidence status --json"],
      author: "parent",
    });
    expect(created).toMatchObject({
      state: "created",
      action: { id: "OA1", status: "pending" },
      handoff: { id: "HO1", status: "user-action-required" },
    });
  } finally {
    await store.dispose();
  }
});

test("operator-action materialization rejects a mismatched pre-existing handoff atomically", async () => {
  const store = new InMemoryLedgerStore({ now: () => NOW });
  await store.init();
  try {
    const milestone = await store.createMilestone({ title: "mismatched handoff" });
    const goal = await store.createItem("goals", milestone.id, {
      status: "planned",
      fields: { title: "goal", description: "goal" },
    });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "deploy",
        description:
          "CQ-OPERATOR-ACTION v1 activate-implementation-evidence. User deploys; parent measures.",
        ledgerRefs: [`goals:${goal.id}`],
      },
    });
    const forged = await store.createItem("handoffs", milestone.id, {
      id: "HO1",
      status: "drained",
      fields: {
        summary: "forged",
        ledgerRefs: ["operatorActions:OA1"],
      },
    });

    await expect(
      materializeOperatorAction(store, {
        taskId: task.id,
        expectedOutputIdentity: IDENTITY,
        expectedEvidence: ["cq ledger implementation-evidence status --json"],
        author: "parent",
      }),
    ).rejects.toThrow(OperatorActionConflictError);
    expect(() => store.fetchItem("operatorActions", "OA1")).toThrow();
    expect(store.fetchItem("handoffs", "HO1")).toEqual(forged);
  } finally {
    await store.dispose();
  }
});

for (const failAt of [1, 2, 3]) {
  test(`filesystem materialization restart is old-or-new after durable boundary ${String(failAt)}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-operator-materialization-fault-"));
    dirs.push(root);
    let armed = false;
    let writes = 0;
    let store = new FsLedgerStore({
      root,
      now: () => NOW,
      atomicWrite: async (filePath, text) => {
        if (armed) {
          writes += 1;
          if (writes === failAt) {
            throw new Error(`injected materialization boundary ${String(failAt)}`);
          }
        }
        await productionAtomicWrite(filePath, text);
      },
    });
    await store.init();
    const milestone = await store.createMilestone({ title: "fault materialization" });
    const goal = await store.createItem("goals", milestone.id, {
      status: "planned",
      fields: { title: "goal", description: "goal" },
    });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "deploy",
        description:
          "CQ-OPERATOR-ACTION v1 activate-implementation-evidence. User deploys; parent measures.",
        ledgerRefs: [`goals:${goal.id}`],
      },
    });
    const input = {
      taskId: task.id,
      expectedOutputIdentity: IDENTITY,
      expectedEvidence: ["cq ledger implementation-evidence status --json"],
      author: "parent",
    } as const;
    armed = true;
    await expect(materializeOperatorAction(store, input)).rejects.toThrow(
      `injected materialization boundary ${String(failAt)}`,
    );
    await store.dispose();

    store = new FsLedgerStore({ root, now: () => NOW });
    await store.init();
    try {
      const oldState = { actions: [], handoffs: [] };
      const newState = {
        actions: [{ id: "OA1", status: "pending" }],
        handoffs: [{ id: "HO1", status: "user-action-required" }],
      };
      const recovery = expectCoherentOldOrNew(
        materializedPairState(store),
        oldState,
        newState,
      );
      const replay = await materializeOperatorAction(store, input);
      expect(replay.state).toBe(recovery === "old" ? "created" : "existing");
      expect(materializedPairState(store)).toEqual(newState);
    } finally {
      await store.dispose();
    }
  });
}

for (const factory of factories) {
  describe(`operator-action lifecycle (${factory.name})`, () => {
    test("supersedes a strict operator-action task before materialization [D395]", async () => {
      const store = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "obsolete deployment" });
        const goal = await store.createItem("goals", milestone.id, {
          status: "planned",
          fields: { title: "goal", description: "goal" },
        });
        const task = await store.createItem("tasks", milestone.id, {
          status: "planned",
          fields: {
            headline: "obsolete deployment",
            description: "CQ-OPERATOR-ACTION v1 obsolete-deployment. User deploys.",
            ledgerRefs: [`goals:${goal.id}`],
          },
        });

        const input = {
          actionId: `OA${task.id.slice(1)}`,
          expectedRevision: 1,
          reason: "deployment requirement withdrawn before materialization",
          supersededAt: NOW,
          author: "parent",
        } as const;
        const result = await supersedeOperatorAction(store, input);

        expect(result).toEqual({
          task: expect.objectContaining({
            id: task.id,
            status: "abandoned",
            fields: expect.objectContaining({
              completion:
                `Superseded operator action OA${task.id.slice(1)}: ` +
                "deployment requirement withdrawn before materialization",
            }),
          }),
        });
        expect(() => store.fetchItem("operatorActions", `OA${task.id.slice(1)}`)).toThrow();
        expect(await supersedeOperatorAction(store, input)).toEqual(result);
        await expect(
          supersedeOperatorAction(store, {
            ...input,
            reason: "different withdrawal evidence",
          }),
        ).rejects.toThrow(/abandoned with different evidence/);
      } finally {
        await store.dispose();
      }
    });

    test("supersedes a pending action and atomically abandons its planned task [D395]", async () => {
      const store = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "superseded deployment" });
        const goal = await store.createItem("goals", milestone.id, {
          status: "planned",
          fields: { title: "goal", description: "goal" },
        });
        const task = await store.createItem("tasks", milestone.id, {
          status: "planned",
          fields: {
            headline: "obsolete deployment",
            description: "CQ-OPERATOR-ACTION v1 obsolete-deployment. User deploys.",
            ledgerRefs: [`goals:${goal.id}`],
          },
        });
        const created = await materializeOperatorAction(store, {
          taskId: task.id,
          expectedOutputIdentity: IDENTITY,
          expectedEvidence: ["cq --version"],
        });

        const result = await supersedeOperatorAction(store, {
          actionId: created.action.id,
          expectedRevision: 1,
          reason: "deployment requirement replaced",
          supersededAt: NOW,
          author: "parent",
        });

        expect(result).toMatchObject({
          action: { status: "superseded" },
          task: { id: task.id, status: "abandoned" },
        });
        expect(store.fetchItem("operatorActions", created.action.id)).toMatchObject({
          status: "superseded",
          fields: { supersededReason: "deployment requirement replaced" },
        });
        expect(store.fetchItem("tasks", task.id).status).toBe("abandoned");
      } finally {
        await store.dispose();
      }
    });

    test("a goal cannot become terminal while it has a nonterminal sealed child [D397]", async () => {
      const store = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "owned plan" });
        const goal = await store.createItem("goals", milestone.id, {
          status: "building",
          fields: { title: "goal", description: "goal" },
        });
        const atomic = store as LedgerStore & {
          runAtomicOwnedMutation<T>(mutate: (tx: WorksetOwnedWriteTx) => T): Promise<T>;
        };
        await atomic.runAtomicOwnedMutation((tx) =>
          tx.createItemWithSealedOwnership(
            "tasks",
            milestone.id,
            { status: "planned", fields: { headline: "unfinished" } },
            { ownerRef: `goals:${goal.id}`, edgeKind: "finalized-manifest" },
          ),
        );

        await expect(store.updateItem("goals", goal.id, { status: "done" })).rejects.toThrow(
          /nonterminal sealed children/,
        );
        expect(store.fetchItem("goals", goal.id).status).toBe("building");
      } finally {
        await store.dispose();
      }
    });

    test("terminal-item archival retains a historical terminal goal with active sealed children [D397]", async () => {
      const store = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "historical drift" });
        const goal = await store.createItem("goals", milestone.id, {
          status: "done",
          fields: { title: "historical goal", description: "goal" },
        });
        const atomic = store as LedgerStore & {
          runAtomicOwnedMutation<T>(mutate: (tx: WorksetOwnedWriteTx) => T): Promise<T>;
          runAtomicGenericMutation<T>(
            mutate: (tx: {
              archiveTerminalItems(
                ledgerIds: readonly string[],
                summary: string,
                gatePolicy: "retain-active-gates",
              ): T;
            }) => T,
            readRoots: () => Promise<{ roots: string[]; epoch: number }>,
          ): Promise<T>;
        };
        await atomic.runAtomicOwnedMutation((tx) =>
          tx.createItemWithSealedOwnership(
            "tasks",
            milestone.id,
            { status: "planned", fields: { headline: "unfinished historical child" } },
            { ownerRef: `goals:${goal.id}`, edgeKind: "finalized-manifest" },
          ),
        );

        const result = await atomic.runAtomicGenericMutation(
          (tx) =>
            tx.archiveTerminalItems(
              ["goals"],
              "terminal cleanup",
              "retain-active-gates",
            ),
          async () => ({ roots: [], epoch: 0 }),
        );
        expect(result).toMatchObject({
          archivedItems: 0,
          retainedActiveOwners: [`goals:${goal.id}`],
        });
        expect(store.fetchItem("goals", goal.id).status).toBe("done");
      } finally {
        await store.dispose();
      }
    });

    test("reuses one action/handoff, fences identity, preserves evidence, and completes only verified", async () => {
      const store = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "deploy" });
        const goal = await store.createItem("goals", milestone.id, {
          status: "planned",
          fields: { title: "goal", description: "goal" },
        });
        const task = await store.createItem("tasks", milestone.id, {
          status: "planned",
          fields: {
            headline: "deploy",
            description: "CQ-OPERATOR-ACTION v1 deployed-output. User deploys; parent measures.",
            ledgerRefs: [`goals:${goal.id}`],
          },
        });

        expect(derivePredicates(store).pImplement.items).toEqual([]);
        expect(derivePredicates(store).pOperatorAction.items).toEqual([task.id]);

        const first = await materializeOperatorAction(store, {
          taskId: task.id,
          expectedOutputIdentity: IDENTITY,
          expectedEvidence: ["cq --version", "cq worktree probe"],
          author: "parent",
        });
        expect(first.state).toBe("created");
        expect(first.action.id).toBe("OA1");
        expect(first.handoff.id).toBe("HO1");
        const restarted = await materializeOperatorAction(store, {
          taskId: task.id,
          expectedOutputIdentity: IDENTITY,
          expectedEvidence: ["cq --version", "cq worktree probe"],
          author: "parent",
        });
        expect(restarted.state).toBe("existing");
        expect(restarted.action.id).toBe(first.action.id);
        expect(restarted.handoff.id).toBe(first.handoff.id);
        expect(
          store.updateItem("operatorActions", first.action.id, { status: "acknowledged" }),
        ).rejects.toBeInstanceOf(LedgerError);
        expect(
          materializeOperatorAction(store, {
            taskId: task.id,
            expectedOutputIdentity: "/nix/store/wrong",
            expectedEvidence: ["cq --version", "cq worktree probe"],
          }),
        ).rejects.toBeInstanceOf(OperatorActionConflictError);

        const mismatch = await acknowledgeOperatorAction(store, {
          actionId: first.action.id,
          expectedRevision: 1,
          outputIdentity: "/nix/store/wrong",
          acknowledgedAt: NOW,
        });
        expect(mismatch.state).toBe("pending");
        expect(store.fetchItem("operatorActions", first.action.id).status).toBe("pending");
        expect(store.updateItem("tasks", task.id, { status: "done" })).rejects.toBeInstanceOf(
          LedgerError,
        );
        expect(store.updateItem("tasks", task.id, { status: "wip" })).rejects.toBeInstanceOf(
          LedgerError,
        );
        expect(
          store.updateItem("tasks", task.id, {
            status: "done",
            fields: { description: "ordinary task" },
          }),
        ).rejects.toBeInstanceOf(LedgerError);
        expect(
          store.updateItem("tasks", task.id, {
            fields: {
              description: "CQ-OPERATOR-ACTION v1 different-action. User deploys.",
            },
          }),
        ).rejects.toBeInstanceOf(LedgerError);
        expect(
          completeOperatorActionTask(store, first.action.id, 1, "premature", {
            author: "parent",
          }),
        ).rejects.toBeInstanceOf(LedgerError);

        const acknowledged = await acknowledgeOperatorAction(store, {
          actionId: first.action.id,
          expectedRevision: 1,
          outputIdentity: IDENTITY,
          acknowledgedAt: NOW,
        });
        expect(acknowledged.state).toBe("acknowledged");
        const failedProbe = await recordOperatorActionEvidence(
          store,
          first.action.id,
          1,
          {
            command: "cq --version",
            stdout: "",
            stderr: "not deployed",
            exitCode: 1,
            outputIdentity: IDENTITY,
            observedAt: NOW,
          },
          { author: "parent" },
        );
        expect(failedProbe.state).toBe("pending");

        await acknowledgeOperatorAction(store, {
          actionId: first.action.id,
          expectedRevision: 1,
          outputIdentity: IDENTITY,
          acknowledgedAt: NOW,
        });
        const firstProbe = await recordOperatorActionEvidence(
          store,
          first.action.id,
          1,
          {
            command: "cq worktree probe",
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            outputIdentity: IDENTITY,
            observedAt: NOW,
          },
          { author: "parent" },
        );
        expect(firstProbe.state).toBe("acknowledged");

        const mismatchingProbe = await recordOperatorActionEvidence(
          store,
          first.action.id,
          1,
          {
            command: "cq --version",
            stdout: "cq 1",
            stderr: "",
            exitCode: 0,
            outputIdentity: "/nix/store/wrong",
            observedAt: NOW,
          },
          { author: "parent" },
        );
        expect(mismatchingProbe.state).toBe("pending");

        await acknowledgeOperatorAction(store, {
          actionId: first.action.id,
          expectedRevision: 1,
          outputIdentity: IDENTITY,
          acknowledgedAt: NOW,
        });
        const stillAcknowledged = await recordOperatorActionEvidence(
          store,
          first.action.id,
          1,
          {
            command: "cq worktree probe",
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            outputIdentity: IDENTITY,
            observedAt: NOW,
          },
          { author: "parent" },
        );
        expect(stillAcknowledged.state).toBe("acknowledged");
        const verified = await recordOperatorActionEvidence(
          store,
          first.action.id,
          1,
          {
            command: "cq --version",
            stdout: "cq 1",
            stderr: "",
            exitCode: 0,
            outputIdentity: IDENTITY,
            observedAt: NOW,
          },
          { author: "parent" },
        );
        expect(verified.state).toBe("verified");
        expect(verified.action.fields["evidence"]).toHaveLength(5);
        expect(
          await acknowledgeOperatorAction(store, {
            actionId: first.action.id,
            expectedRevision: 1,
            outputIdentity: IDENTITY,
            acknowledgedAt: NOW,
          }),
        ).toMatchObject({ state: "verified", action: { status: "verified" } });
        expect(store.fetchItem("tasks", task.id).status).toBe("planned");
        const completed = await completeOperatorActionTask(
          store,
          first.action.id,
          1,
          "deployed identity and both probes verified",
          { author: "parent" },
        );
        expect(completed.status).toBe("done");
        expect(store.fetchItem("operatorActions", first.action.id).fields["completion"]).toBe(
          "deployed identity and both probes verified",
        );
      } finally {
        await store.dispose();
      }
    });

    test("rejects true malformed and duplicate envelopes while inline mentions remain mutable [Behavioral-Active Blackbox-Group]", async () => {
      const store = await factory.build();
      try {
        const milestone = await store.createMilestone({ title: "tasks" });
        const goal = await store.createItem("goals", milestone.id, {
          status: "planned",
          fields: { title: "goal", description: "goal" },
        });
        const ordinary = await store.createItem("tasks", milestone.id, {
          status: "planned",
          fields: { headline: "ordinary", ledgerRefs: [`goals:${goal.id}`] },
        });
        expect(derivePredicates(store).pImplement.items).toEqual([ordinary.id]);
        // regression: D368 — an inline marker is ordinary prose, not an envelope.
        const inlineMention = await store.createItem("tasks", milestone.id, {
          status: "planned",
          fields: {
            headline: "ordinary inline mention",
            description: "prefix CQ-OPERATOR-ACTION v1 action.",
            ledgerRefs: [`goals:${goal.id}`],
          },
        });
        await expect(
          store.updateItem("tasks", inlineMention.id, {
            fields: { description: "updated prose mentioning CQ-OPERATOR-ACTION" },
          }),
        ).resolves.toMatchObject({ id: inlineMention.id });
        expect(derivePredicates(store).pImplement.items).toContain(inlineMention.id);
        await expect(
          store.createItem("tasks", milestone.id, {
            status: "planned",
            fields: {
              headline: "invalid key",
              description: "CQ-OPERATOR-ACTION v1 invalid_key. User deploys.",
              ledgerRefs: [`goals:${goal.id}`],
            },
          }),
        ).rejects.toBeInstanceOf(OperatorActionEnvelopeError);
        await expect(
          store.createItem("tasks", milestone.id, {
            status: "planned",
            fields: {
              headline: "duplicate",
              description: "CQ-OPERATOR-ACTION v1 action. CQ-OPERATOR-ACTION v1 second.",
              ledgerRefs: [`goals:${goal.id}`],
            },
          }),
        ).rejects.toBeInstanceOf(OperatorActionEnvelopeError);
        await expect(
          store.createItem("tasks", milestone.id, {
            status: "wip",
            fields: {
              headline: "already owned",
              description: "CQ-OPERATOR-ACTION v1 deployment. User deploys.",
              ledgerRefs: [`goals:${goal.id}`],
            },
          }),
        ).rejects.toBeInstanceOf(LedgerError);
      } finally {
        await store.dispose();
      }
    });
  });
}

test("shared SQLite serializes revise versus acknowledge at the authoritative store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cq-operator-action-shared-sqlite-"));
  dirs.push(root);
  const dbPath = path.join(root, "ledger.db");
  const first = new SqliteLedgerStore({ dbPath, now: () => NOW });
  const second = new SqliteLedgerStore({ dbPath, now: () => NOW });
  await first.init();
  await second.init();
  try {
    const milestone = await first.createMilestone({ title: "shared race" });
    const goal = await first.createItem("goals", milestone.id, {
      status: "planned",
      fields: { title: "goal", description: "goal" },
    });
    const task = await first.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "deploy",
        description: "CQ-OPERATOR-ACTION v1 shared-ack-race. User deploys.",
        ledgerRefs: [`goals:${goal.id}`],
      },
    });
    const created = await materializeOperatorAction(first, {
      taskId: task.id,
      expectedOutputIdentity: "/nix/store/revision-1",
      expectedEvidence: ["probe-v1"],
    });
    const [revision, acknowledgement] = await Promise.allSettled([
      reviseOperatorAction(first, {
        actionId: created.action.id,
        expectedRevision: 1,
        expectedOutputIdentity: "/nix/store/revision-2",
        expectedEvidence: ["probe-v2"],
        revisedAt: NOW,
        author: "reviser",
      }),
      acknowledgeOperatorAction(second, {
        actionId: created.action.id,
        expectedRevision: 1,
        outputIdentity: "/nix/store/revision-1",
        acknowledgedAt: NOW,
      }),
    ]);
    expect(revision.status).toBe("fulfilled");
    const final = first.fetchItem("operatorActions", created.action.id);
    expect(final).toMatchObject({ status: "pending", fields: { revision: "2" } });
    const historical = JSON.parse((final.fields["revisionHistory"] as string[])[0]!) as {
      action: { status: string; fields: Record<string, unknown> };
    };
    if (acknowledgement.status === "fulfilled") {
      expect(historical.action).toMatchObject({
        status: "acknowledged",
        fields: { acknowledgedOutputIdentity: "/nix/store/revision-1" },
      });
    } else {
      expect(historical.action.status).toBe("pending");
      expect(historical.action.fields["acknowledgedOutputIdentity"]).toBeUndefined();
    }
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("shared SQLite serializes revise versus evidence without mixed triple state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cq-operator-evidence-shared-sqlite-"));
  dirs.push(root);
  const dbPath = path.join(root, "ledger.db");
  const first = new SqliteLedgerStore({ dbPath, now: () => NOW });
  const second = new SqliteLedgerStore({ dbPath, now: () => NOW });
  await first.init();
  await second.init();
  try {
    const milestone = await first.createMilestone({ title: "shared evidence race" });
    const goal = await first.createItem("goals", milestone.id, {
      status: "planned",
      fields: { title: "goal", description: "goal" },
    });
    const task = await first.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "deploy",
        description: "CQ-OPERATOR-ACTION v1 shared-evidence-race. User deploys.",
        ledgerRefs: [`goals:${goal.id}`],
      },
    });
    const created = await materializeOperatorAction(first, {
      taskId: task.id,
      expectedOutputIdentity: IDENTITY,
      expectedEvidence: ["probe-a", "probe-b"],
    });
    await acknowledgeOperatorAction(first, {
      actionId: created.action.id,
      expectedRevision: 1,
      outputIdentity: IDENTITY,
      acknowledgedAt: NOW,
    });
    const [revision, evidence] = await Promise.allSettled([
      reviseOperatorAction(first, {
        actionId: created.action.id,
        expectedRevision: 1,
        expectedOutputIdentity: "/nix/store/revision-2",
        expectedEvidence: ["probe-v2"],
        revisedAt: NOW,
        author: "reviser",
      }),
      recordOperatorActionEvidence(
        second,
        created.action.id,
        1,
        {
          command: "probe-a",
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          outputIdentity: IDENTITY,
          observedAt: NOW,
        },
        { author: "evidence-recorder" },
      ),
    ]);
    const action = first.fetchItem("operatorActions", created.action.id);
    const triple = JSON.stringify({
      action,
      task: first.fetchItem("tasks", task.id),
      handoff: first.fetchItem("handoffs", created.handoff.id),
    });
    if (revision.status === "fulfilled") {
      expect(evidence.status).toBe("rejected");
      expect(action).toMatchObject({ status: "pending", fields: { revision: "2" } });
      expect(action.fields["evidence"]).toBeUndefined();
    } else {
      expect(evidence.status).toBe("fulfilled");
      expect(action).toMatchObject({ status: "acknowledged", fields: { revision: "1" } });
      expect(action.fields["evidence"]).toHaveLength(1);
      await expect(
        reviseOperatorAction(first, {
          actionId: created.action.id,
          expectedRevision: 1,
          expectedOutputIdentity: "/nix/store/revision-2",
          expectedEvidence: ["probe-v2"],
          revisedAt: NOW,
          author: "reviser",
        }),
      ).rejects.toThrow(/after evidence/);
      expect(
        JSON.stringify({
          action: first.fetchItem("operatorActions", created.action.id),
          task: first.fetchItem("tasks", task.id),
          handoff: first.fetchItem("handoffs", created.handoff.id),
        }),
      ).toBe(triple);
    }
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

for (const failAt of [1, 2, 3, 4, 5]) {
  test(`filesystem revision restart is old-or-new after durable boundary ${String(failAt)}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-operator-revision-fault-"));
    dirs.push(root);
    let armed = false;
    let writes = 0;
    let store = new FsLedgerStore({
      root,
      now: () => NOW,
      atomicWrite: async (filePath, text) => {
        if (armed) {
          writes += 1;
          if (writes === failAt) throw new Error(`injected revision boundary ${String(failAt)}`);
        }
        await productionAtomicWrite(filePath, text);
      },
    });
    await store.init();
    const milestone = await store.createMilestone({ title: "fault revision" });
    const goal = await store.createItem("goals", milestone.id, {
      status: "planned",
      fields: { title: "goal", description: "goal" },
    });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "deploy",
        description: "CQ-OPERATOR-ACTION v1 fault-revision. User deploys.",
        ledgerRefs: [`goals:${goal.id}`],
      },
    });
    const created = await materializeOperatorAction(store, {
      taskId: task.id,
      expectedOutputIdentity: "/nix/store/revision-1",
      expectedEvidence: ["probe-v1"],
    });
    await acknowledgeOperatorAction(store, {
      actionId: created.action.id,
      expectedRevision: 1,
      outputIdentity: "/nix/store/revision-1",
      acknowledgedAt: NOW,
    });
    await recordOperatorActionEvidence(
      store,
      created.action.id,
      1,
      {
        command: "probe-v1",
        stdout: "",
        stderr: "failed before restart",
        exitCode: 1,
        outputIdentity: "/nix/store/revision-1",
        observedAt: NOW,
      },
      { author: "parent" },
    );
    const oldTriple = fetchOperatorActionTriple(
      store,
      created.action.id,
      task.id,
      created.handoff.id,
    );
    const newTriple = revisedTriple(oldTriple);
    armed = true;
    await expect(
      reviseOperatorAction(store, {
        actionId: created.action.id,
        expectedRevision: 1,
        expectedOutputIdentity: "/nix/store/revision-2",
        expectedEvidence: ["probe-v2"],
        revisedAt: NOW,
        author: "parent",
      }),
    ).rejects.toThrow(`injected revision boundary ${String(failAt)}`);
    await store.dispose();

    store = new FsLedgerStore({ root, now: () => NOW });
    await store.init();
    try {
      const recovered = fetchOperatorActionTriple(
        store,
        created.action.id,
        task.id,
        created.handoff.id,
      );
      const recovery = expectCoherentOldOrNew(recovered, oldTriple, newTriple);
      expect(store.exportPlanLifecycleState()).toBeNull();
      if (recovery === "old") {
        const retried = await reviseOperatorAction(store, {
          actionId: created.action.id,
          expectedRevision: 1,
          expectedOutputIdentity: "/nix/store/revision-2",
          expectedEvidence: ["probe-v2"],
          revisedAt: NOW,
          author: "parent",
        });
        expect(retried).toEqual(newTriple);
        expect(
          fetchOperatorActionTriple(store, created.action.id, task.id, created.handoff.id),
        ).toEqual(newTriple);
      } else {
        await expect(
          reviseOperatorAction(store, {
            actionId: created.action.id,
            expectedRevision: 1,
            expectedOutputIdentity: "/nix/store/revision-2",
            expectedEvidence: ["probe-v2"],
            revisedAt: NOW,
            author: "parent",
          }),
        ).rejects.toThrow(/revision conflict/);
        expect(
          fetchOperatorActionTriple(store, created.action.id, task.id, created.handoff.id),
        ).toEqual(newTriple);
      }
      expect(store.exportPlanLifecycleState()).toBeNull();
    } finally {
      await store.dispose();
    }
  });
}

for (const failAt of [1, 2, 3, 4]) {
  test(`filesystem completion restart is old-or-new after durable boundary ${String(failAt)}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cq-operator-completion-fault-"));
    dirs.push(root);
    let armed = false;
    let writes = 0;
    let store = new FsLedgerStore({
      root,
      now: () => NOW,
      atomicWrite: async (filePath, text) => {
        if (armed) {
          writes += 1;
          if (writes === failAt) throw new Error(`injected completion boundary ${String(failAt)}`);
        }
        await productionAtomicWrite(filePath, text);
      },
    });
    await store.init();
    const milestone = await store.createMilestone({ title: "fault completion" });
    const goal = await store.createItem("goals", milestone.id, {
      status: "planned",
      fields: { title: "goal", description: "goal" },
    });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "deploy",
        description: "CQ-OPERATOR-ACTION v1 fault-completion. User deploys.",
        ledgerRefs: [`goals:${goal.id}`],
      },
    });
    const created = await materializeOperatorAction(store, {
      taskId: task.id,
      expectedOutputIdentity: IDENTITY,
      expectedEvidence: ["probe"],
    });
    await acknowledgeOperatorAction(store, {
      actionId: created.action.id,
      expectedRevision: 1,
      outputIdentity: IDENTITY,
      acknowledgedAt: NOW,
    });
    await recordOperatorActionEvidence(
      store,
      created.action.id,
      1,
      {
        command: "probe",
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        outputIdentity: IDENTITY,
        observedAt: NOW,
      },
      { author: "parent" },
    );
    const oldTriple = fetchOperatorActionTriple(
      store,
      created.action.id,
      task.id,
      created.handoff.id,
    );
    const newTriple = completedTriple(oldTriple);
    armed = true;
    await expect(
      completeOperatorActionTask(store, created.action.id, 1, "verified completion", {
        author: "parent",
      }),
    ).rejects.toThrow(`injected completion boundary ${String(failAt)}`);
    await store.dispose();

    store = new FsLedgerStore({ root, now: () => NOW });
    await store.init();
    try {
      const recovered = fetchOperatorActionTriple(
        store,
        created.action.id,
        task.id,
        created.handoff.id,
      );
      const recovery = expectCoherentOldOrNew(recovered, oldTriple, newTriple);
      expect(store.exportPlanLifecycleState()).toBeNull();
      if (recovery === "old") {
        const retried = await completeOperatorActionTask(
          store,
          created.action.id,
          1,
          "verified completion",
          { author: "parent" },
        );
        expect(retried).toEqual(newTriple.task);
        expect(
          fetchOperatorActionTriple(store, created.action.id, task.id, created.handoff.id),
        ).toEqual(newTriple);
      } else {
        await expect(
          completeOperatorActionTask(store, created.action.id, 1, "verified completion", {
            author: "parent",
          }),
        ).rejects.toThrow(/not planned/);
        expect(
          fetchOperatorActionTriple(store, created.action.id, task.id, created.handoff.id),
        ).toEqual(newTriple);
      }
      expect(store.exportPlanLifecycleState()).toBeNull();
    } finally {
      await store.dispose();
    }
  });
}

test("filesystem restart reuses the durable action and handoff", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cq-operator-action-restart-"));
  dirs.push(root);
  let store = new FsLedgerStore({ root, now: () => NOW });
  await store.init();
  const milestone = await store.createMilestone({ title: "restart" });
  const goal = await store.createItem("goals", milestone.id, {
    status: "planned",
    fields: { title: "goal", description: "goal" },
  });
  const task = await store.createItem("tasks", milestone.id, {
    status: "planned",
    fields: {
      headline: "deploy",
      description: "CQ-OPERATOR-ACTION v1 restart-deployment. User deploys.",
      ledgerRefs: [`goals:${goal.id}`],
    },
  });
  const created = await materializeOperatorAction(store, {
    taskId: task.id,
    expectedOutputIdentity: IDENTITY,
    expectedEvidence: ["cq --version"],
  });
  await store.dispose();

  store = new FsLedgerStore({ root, now: () => NOW });
  await store.init();
  try {
    const resumed = await materializeOperatorAction(store, {
      taskId: task.id,
      expectedOutputIdentity: IDENTITY,
      expectedEvidence: ["cq --version"],
    });
    expect(resumed.state).toBe("existing");
    expect(resumed.action.id).toBe(created.action.id);
    expect(resumed.handoff.id).toBe(created.handoff.id);
    expect(store.fetch("handoffs").milestones.flatMap((group) => group.items)).toHaveLength(1);
  } finally {
    await store.dispose();
  }
});

test("D312 acknowledged pre-evidence action can replace an incorrect immutable manifest", async () => {
  const store = new InMemoryLedgerStore({ now: () => NOW });
  await store.init();
  try {
    const milestone = await store.createMilestone({ title: "revise" });
    const goal = await store.createItem("goals", milestone.id, {
      status: "planned",
      fields: { title: "goal", description: "goal" },
    });
    const task = await store.createItem("tasks", milestone.id, {
      status: "planned",
      fields: {
        headline: "deploy",
        description: "CQ-OPERATOR-ACTION v1 revised-deployment. User deploys.",
        ledgerRefs: [`goals:${goal.id}`],
      },
    });
    const created = await materializeOperatorAction(store, {
      taskId: task.id,
      expectedOutputIdentity: IDENTITY,
      expectedEvidence: ["cq wrong-probe"],
    });
    await acknowledgeOperatorAction(store, {
      actionId: created.action.id,
      expectedRevision: 1,
      outputIdentity: IDENTITY,
      acknowledgedAt: NOW,
    });

    const revised = await reviseOperatorAction(store, {
      actionId: created.action.id,
      expectedRevision: 1,
      expectedOutputIdentity: IDENTITY,
      expectedEvidence: ["cq correct-probe"],
      revisedAt: NOW,
      author: "parent",
    });

    expect(revised.action).toMatchObject({
      status: "pending",
      fields: { revision: "2", expectedEvidence: ["cq correct-probe"] },
    });
  } finally {
    await store.dispose();
  }
});

test("OA2054 failed evidence epoch can be revised with a complete audit and fresh verification", async () => {
  const store = new InMemoryLedgerStore({ now: () => NOW });
  await store.init();
  try {
    await store.createItem("goals", MILESTONES_AMBIENT_ID, {
      id: "G2054",
      status: "clarifying",
      fields: { title: "deploy", description: "deploy" },
    });
    const claimed = await store.claimPlan({
      goalId: "G2054",
      purpose: "initial",
      claimRequestId: "oa2054-claim",
      ownerFenceToken: "A".repeat(22),
      expectedGeneration: null,
      author: "planner",
    });
    if (!claimed.ok) throw new Error("plan claim failed");
    const manifest = {
      milestones: [{ key: "deployment", title: "Deployment" }],
      tasks: [
        {
          key: "operator",
          milestoneKey: "deployment",
          headline: "Deploy",
          description: "CQ-OPERATOR-ACTION v1 oa2054-recovery. User deploys.",
        },
      ],
    } satisfies PlanDraftManifest;
    const first = await store.publishPlanDraft({
      goalId: "G2054",
      claimId: claimed.acknowledgement.claimId,
      generation: claimed.acknowledgement.generation,
      operationId: "oa2054-first",
      ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
      author: "planner",
      manifest,
    });
    if (!first.ok) throw new Error("first plan publication failed");
    const taskId = first.acknowledgement.manifest.tasks[0]!.id;
    const created = await materializeOperatorAction(store, {
      taskId,
      expectedOutputIdentity: "/nix/store/oa2054-v1",
      expectedEvidence: ["probe-a", "probe-b"],
      author: "parent",
    });
    await acknowledgeOperatorAction(store, {
      actionId: created.action.id,
      expectedRevision: 1,
      outputIdentity: "/nix/store/oa2054-v1",
      acknowledgedAt: "2026-08-11T06:01:00.000Z",
    });
    await recordOperatorActionEvidence(
      store,
      created.action.id,
      1,
      {
        command: "probe-a",
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        outputIdentity: "/nix/store/oa2054-v1",
        observedAt: "2026-08-11T06:02:00.000Z",
      },
      { author: "parent" },
    );
    const failed = await recordOperatorActionEvidence(
      store,
      created.action.id,
      1,
      {
        command: "probe-b",
        stdout: "",
        stderr: "failed",
        exitCode: 1,
        outputIdentity: "/nix/store/oa2054-v1",
        observedAt: "2026-08-11T06:03:00.000Z",
      },
      { author: "parent", session: "failed-epoch" },
    );
    expect(failed).toMatchObject({ state: "pending", action: { status: "pending" } });

    const replacement = await store.publishPlanDraft({
      goalId: "G2054",
      claimId: claimed.acknowledgement.claimId,
      generation: claimed.acknowledgement.generation,
      operationId: "oa2054-replacement",
      ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
      author: "planner",
      manifest,
    });
    if (!replacement.ok) throw new Error("replacement plan publication failed");
    const before = {
      action: store.fetchItem("operatorActions", created.action.id),
      task: store.fetchItem("tasks", taskId),
      handoff: store.fetchItem("handoffs", created.handoff.id),
    };
    expect(before.task.status).toBe("abandoned");

    const revised = await reviseOperatorAction(store, {
      actionId: created.action.id,
      expectedRevision: 1,
      expectedOutputIdentity: "/nix/store/oa2054-v2",
      expectedEvidence: ["probe-v2"],
      revisedAt: "2026-08-11T06:04:00.000Z",
      author: "parent",
      session: "revision",
    });
    expect(revised).toMatchObject({
      action: {
        status: "pending",
        fields: {
          revision: "2",
          expectedOutputIdentity: "/nix/store/oa2054-v2",
          expectedEvidence: ["probe-v2"],
        },
      },
      task: { status: "planned" },
      handoff: {
        status: "user-action-required",
        fields: {
          summary: expect.stringContaining("revision 2"),
          handoffReasons: [expect.stringContaining("revision 2")],
        },
      },
    });
    for (const field of [
      "acknowledgedOutputIdentity",
      "acknowledgedAt",
      "acknowledgementEpoch",
      "evidence",
      "lastFailure",
    ]) {
      expect(revised.action.fields[field]).toBeUndefined();
    }
    const audit = JSON.parse((revised.action.fields["revisionHistory"] as string[])[0]!) as {
      revision: number;
      action: typeof before.action;
      task: typeof before.task;
      handoff: typeof before.handoff;
    };
    expect(audit).toEqual({ revision: 1, ...before });

    await expect(
      reviseOperatorAction(store, {
        actionId: created.action.id,
        expectedRevision: 1,
        expectedOutputIdentity: "/nix/store/stale",
        expectedEvidence: ["stale"],
        revisedAt: "2026-08-11T06:05:00.000Z",
        author: "stale-parent",
      }),
    ).rejects.toThrow(/revision conflict/);
    expect(
      await acknowledgeOperatorAction(store, {
        actionId: created.action.id,
        expectedRevision: 2,
        outputIdentity: "/nix/store/oa2054-v2",
        acknowledgedAt: "2026-08-11T06:06:00.000Z",
      }),
    ).toMatchObject({ state: "acknowledged" });
    expect(
      await recordOperatorActionEvidence(
        store,
        created.action.id,
        2,
        {
          command: "probe-v2",
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          outputIdentity: "/nix/store/oa2054-v2",
          observedAt: "2026-08-11T06:07:00.000Z",
        },
        { author: "parent" },
      ),
    ).toMatchObject({ state: "verified", action: { status: "verified" } });
  } finally {
    await store.dispose();
  }
});

test("failed-evidence revision rejects malformed, stale, inconsistent, and unsafe stored state", async () => {
  const cases: ReadonlyArray<{
    name: string;
    mutate(action: Item, task: Item, handoff: Item): void;
  }> = [
    {
      name: "malformed evidence",
      mutate(action) {
        (action.fields as Record<string, unknown>)["evidence"] = [1];
      },
    },
    {
      name: "malformed expected evidence",
      mutate(action) {
        (action.fields as Record<string, unknown>)["expectedEvidence"] = ["probe-b", 42];
      },
    },
    {
      name: "malformed revision history",
      mutate(action) {
        (action.fields as Record<string, unknown>)["revisionHistory"] = ["prior", 42];
      },
    },
    {
      name: "inconsistent last failure",
      mutate(action) {
        action.fields["lastFailure"] = (action.fields["evidence"] as string[])[0]!;
      },
    },
    {
      name: "stale revision",
      mutate(action) {
        const evidence = action.fields["evidence"] as string[];
        const terminal = JSON.parse(evidence[evidence.length - 1]!) as Record<string, unknown>;
        terminal["revision"] = 2;
        evidence[evidence.length - 1] = JSON.stringify(terminal);
        action.fields["lastFailure"] = evidence[evidence.length - 1]!;
      },
    },
    {
      name: "stale acknowledgement epoch",
      mutate(action) {
        action.fields["acknowledgementEpoch"] = "2";
      },
    },
    {
      name: "successful terminal evidence",
      mutate(action) {
        const evidence = action.fields["evidence"] as string[];
        const terminal = JSON.parse(evidence[evidence.length - 1]!) as Record<string, unknown>;
        terminal["exitCode"] = 0;
        const encoded = JSON.stringify(terminal);
        evidence[evidence.length - 1] = encoded;
        action.fields["lastFailure"] = encoded;
      },
    },
    {
      name: "unsafe task",
      mutate(_action, task) {
        task.status = "wip";
      },
    },
    {
      name: "unsafe handoff",
      mutate(_action, _task, handoff) {
        handoff.status = "drained";
      },
    },
  ];

  for (const testCase of cases) {
    const store = new InMemoryLedgerStore({ now: () => NOW });
    await store.init();
    try {
      const milestone = await store.createMilestone({ title: testCase.name });
      const goal = await store.createItem("goals", milestone.id, {
        status: "planned",
        fields: { title: "goal", description: "goal" },
      });
      const task = await store.createItem("tasks", milestone.id, {
        status: "planned",
        fields: {
          headline: "deploy",
          description: `CQ-OPERATOR-ACTION v1 ${testCase.name.replaceAll(" ", "-")}. User deploys.`,
          ledgerRefs: [`goals:${goal.id}`],
        },
      });
      const created = await materializeOperatorAction(store, {
        taskId: task.id,
        expectedOutputIdentity: IDENTITY,
        expectedEvidence: ["probe-a", "probe-b"],
      });
      await acknowledgeOperatorAction(store, {
        actionId: created.action.id,
        expectedRevision: 1,
        outputIdentity: IDENTITY,
        acknowledgedAt: NOW,
      });
      await recordOperatorActionEvidence(
        store,
        created.action.id,
        1,
        {
          command: "probe-a",
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          outputIdentity: IDENTITY,
          observedAt: NOW,
        },
        { author: "parent" },
      );
      await recordOperatorActionEvidence(
        store,
        created.action.id,
        1,
        {
          command: "probe-b",
          stdout: "",
          stderr: "failed",
          exitCode: 1,
          outputIdentity: IDENTITY,
          observedAt: NOW,
        },
        { author: "parent" },
      );
      const action = mutableStoredItem(store, "operatorActions", created.action.id);
      const storedTask = mutableStoredItem(store, "tasks", task.id);
      const handoff = mutableStoredItem(store, "handoffs", created.handoff.id);
      testCase.mutate(action, storedTask, handoff);
      const before = JSON.stringify({ action, task: storedTask, handoff });
      await expect(
        reviseOperatorAction(store, {
          actionId: created.action.id,
          expectedRevision: 1,
          expectedOutputIdentity: "/nix/store/rejected",
          expectedEvidence: ["probe-v2"],
          revisedAt: NOW,
          author: "parent",
        }),
        testCase.name,
      ).rejects.toThrow();
      expect(
        JSON.stringify({
          action: mutableStoredItem(store, "operatorActions", created.action.id),
          task: mutableStoredItem(store, "tasks", task.id),
          handoff: mutableStoredItem(store, "handoffs", created.handoff.id),
        }),
        testCase.name,
      ).toBe(before);
    } finally {
      await store.dispose();
    }
  }
});

test("legacy operator actions without a revision field read as revision 1", () => {
  expect(
    operatorActionRevision({
      id: "OA2054",
      milestoneId: "M1",
      status: "pending",
      fields: {},
      createdAt: NOW,
      updatedAt: NOW,
    }),
  ).toBe(1);
});

test("filesystem restart materializes and revises a persisted legacy action", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cq-operator-action-legacy-revision-"));
  dirs.push(root);
  let store = new FsLedgerStore({ root, now: () => NOW });
  await store.init();
  const milestone = await store.createMilestone({ title: "legacy revision" });
  const goal = await store.createItem("goals", milestone.id, {
    status: "planned",
    fields: { title: "legacy goal", description: "legacy goal" },
  });
  const task = await store.createItem("tasks", milestone.id, {
    status: "planned",
    fields: {
      headline: "legacy deploy",
      description: "CQ-OPERATOR-ACTION v1 legacy-revision. User deploys.",
      ledgerRefs: [`goals:${goal.id}`],
    },
  });
  const created = await materializeOperatorAction(store, {
    taskId: task.id,
    expectedOutputIdentity: "/nix/store/legacy-revision-1",
    expectedEvidence: ["legacy-probe-v1"],
  });
  await store.dispose();

  const actionPath = path.join(root, ".cq", "operatorActions.md");
  const currentSource = await readFile(actionPath, "utf8");
  const legacySource = currentSource.replace('- revision: "1"\n', "");
  expect(legacySource).not.toBe(currentSource);
  await writeFile(actionPath, legacySource);

  store = new FsLedgerStore({ root, now: () => NOW });
  await store.init();
  try {
    const resumed = await materializeOperatorAction(store, {
      taskId: task.id,
      expectedOutputIdentity: "/nix/store/legacy-revision-1",
      expectedEvidence: ["legacy-probe-v1"],
    });
    expect(resumed.state).toBe("existing");
    expect(operatorActionRevision(resumed.action)).toBe(1);

    const revised = await reviseOperatorAction(store, {
      actionId: created.action.id,
      expectedRevision: 1,
      expectedOutputIdentity: "/nix/store/legacy-revision-2",
      expectedEvidence: ["legacy-probe-v2"],
      revisedAt: NOW,
      author: "legacy-reviser",
    });
    expect(revised.action.fields["revision"]).toBe("2");
    const audit = JSON.parse((revised.action.fields["revisionHistory"] as string[])[0]!) as {
      revision: number;
      action: { id: string; fields: Record<string, unknown> };
    };
    expect(audit).toMatchObject({
      revision: 1,
      action: {
        id: created.action.id,
        fields: {
          expectedOutputIdentity: "/nix/store/legacy-revision-1",
          expectedEvidence: ["legacy-probe-v1"],
        },
      },
    });
  } finally {
    await store.dispose();
  }
});

for (const factory of factories) {
  test(`revision lifecycle preserves audit and fences stale calls (${factory.name})`, async () => {
    const store = await factory.build();
    try {
      const milestone = await store.createMilestone({ title: "revision audit" });
      const goal = await store.createItem("goals", milestone.id, {
        status: "planned",
        fields: { title: "goal", description: "goal" },
      });
      const task = await store.createItem("tasks", milestone.id, {
        status: "planned",
        fields: {
          headline: "deploy",
          description: "CQ-OPERATOR-ACTION v1 audit-deployment. User deploys.",
          ledgerRefs: [`goals:${goal.id}`],
        },
      });
      const created = await materializeOperatorAction(store, {
        taskId: task.id,
        expectedOutputIdentity: "/nix/store/revision-1",
        expectedEvidence: ["probe-v1"],
      });
      await acknowledgeOperatorAction(store, {
        actionId: created.action.id,
        expectedRevision: 1,
        outputIdentity: "/nix/store/revision-1",
        acknowledgedAt: NOW,
      });
      const revised = await reviseOperatorAction(store, {
        actionId: created.action.id,
        expectedRevision: 1,
        expectedOutputIdentity: "/nix/store/revision-2",
        expectedEvidence: ["probe-v2", "probe-v2-extra"],
        revisedAt: NOW,
        author: "parent",
      });
      expect(revised.action).toMatchObject({
        status: "pending",
        fields: {
          revision: "2",
          expectedOutputIdentity: "/nix/store/revision-2",
          expectedEvidence: ["probe-v2", "probe-v2-extra"],
        },
      });
      expect(revised.action.fields["acknowledgedAt"]).toBeUndefined();
      const history = revised.action.fields["revisionHistory"] as string[];
      expect(history).toHaveLength(1);
      expect(JSON.parse(history[0]!) as unknown).toMatchObject({
        revision: 1,
        action: {
          status: "acknowledged",
          fields: {
            expectedOutputIdentity: "/nix/store/revision-1",
            expectedEvidence: ["probe-v1"],
            acknowledgedOutputIdentity: "/nix/store/revision-1",
          },
        },
        task: { id: task.id, status: "planned" },
        handoff: { id: created.handoff.id, status: "user-action-required" },
      });

      const beforeStale = JSON.stringify({
        action: store.fetchItem("operatorActions", created.action.id),
        task: store.fetchItem("tasks", task.id),
        handoff: store.fetchItem("handoffs", created.handoff.id),
      });
      await expect(
        acknowledgeOperatorAction(store, {
          actionId: created.action.id,
          expectedRevision: 1,
          outputIdentity: "/nix/store/revision-1",
          acknowledgedAt: NOW,
        }),
      ).rejects.toThrow(/revision conflict/);
      expect(
        JSON.stringify({
          action: store.fetchItem("operatorActions", created.action.id),
          task: store.fetchItem("tasks", task.id),
          handoff: store.fetchItem("handoffs", created.handoff.id),
        }),
      ).toBe(beforeStale);

      await acknowledgeOperatorAction(store, {
        actionId: created.action.id,
        expectedRevision: 2,
        outputIdentity: "/nix/store/revision-2",
        acknowledgedAt: NOW,
      });
      await expect(
        recordOperatorActionEvidence(
          store,
          created.action.id,
          1,
          {
            command: "probe-v1",
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            outputIdentity: "/nix/store/revision-1",
            observedAt: NOW,
          },
          { author: "parent" },
        ),
      ).rejects.toThrow(/revision conflict/);
      await recordOperatorActionEvidence(
        store,
        created.action.id,
        2,
        {
          command: "probe-v2",
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          outputIdentity: "/nix/store/revision-2",
          observedAt: NOW,
        },
        { author: "parent" },
      );
      const postEvidence = JSON.stringify({
        action: store.fetchItem("operatorActions", created.action.id),
        task: store.fetchItem("tasks", task.id),
        handoff: store.fetchItem("handoffs", created.handoff.id),
      });
      await expect(
        reviseOperatorAction(store, {
          actionId: created.action.id,
          expectedRevision: 2,
          expectedOutputIdentity: "/nix/store/revision-3",
          expectedEvidence: ["probe-v3"],
          revisedAt: NOW,
          author: "parent",
        }),
      ).rejects.toThrow(/after evidence/);
      expect(
        JSON.stringify({
          action: store.fetchItem("operatorActions", created.action.id),
          task: store.fetchItem("tasks", task.id),
          handoff: store.fetchItem("handoffs", created.handoff.id),
        }),
      ).toBe(postEvidence);
      await recordOperatorActionEvidence(
        store,
        created.action.id,
        2,
        {
          command: "probe-v2-extra",
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          outputIdentity: "/nix/store/revision-2",
          observedAt: NOW,
        },
        { author: "parent" },
      );
      await expect(
        completeOperatorActionTask(store, created.action.id, 1, "stale", {
          author: "parent",
        }),
      ).rejects.toThrow(/revision conflict/);
      expect(
        await completeOperatorActionTask(store, created.action.id, 2, "revision 2 verified", {
          author: "parent",
        }),
      ).toMatchObject({ status: "done" });
    } finally {
      await store.dispose();
    }
  });

  test(`exactly one simultaneous manifest revision wins (${factory.name})`, async () => {
    const store = await factory.build();
    try {
      const milestone = await store.createMilestone({ title: "revision race" });
      const goal = await store.createItem("goals", milestone.id, {
        status: "planned",
        fields: { title: "goal", description: "goal" },
      });
      const task = await store.createItem("tasks", milestone.id, {
        status: "planned",
        fields: {
          headline: "deploy",
          description: "CQ-OPERATOR-ACTION v1 race-deployment. User deploys.",
          ledgerRefs: [`goals:${goal.id}`],
        },
      });
      const created = await materializeOperatorAction(store, {
        taskId: task.id,
        expectedOutputIdentity: IDENTITY,
        expectedEvidence: ["probe-v1"],
      });
      const revisions = await Promise.allSettled([
        reviseOperatorAction(store, {
          actionId: created.action.id,
          expectedRevision: 1,
          expectedOutputIdentity: "/nix/store/winner-a",
          expectedEvidence: ["probe-a"],
          revisedAt: NOW,
          author: "parent-a",
        }),
        reviseOperatorAction(store, {
          actionId: created.action.id,
          expectedRevision: 1,
          expectedOutputIdentity: "/nix/store/winner-b",
          expectedEvidence: ["probe-b"],
          revisedAt: NOW,
          author: "parent-b",
        }),
      ]);
      expect(revisions.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(revisions.filter(({ status }) => status === "rejected")).toHaveLength(1);
      expect(store.fetchItem("operatorActions", created.action.id).fields["revision"]).toBe("2");
    } finally {
      await store.dispose();
    }
  });

  test(`typed revision alone revives an abandoned strict task (${factory.name})`, async () => {
    const store = (await factory.build()) as LedgerStore & PlanLifecycleStore;
    try {
      await store.createItem("goals", MILESTONES_AMBIENT_ID, {
        id: "G2054",
        status: "clarifying",
        fields: { title: "deploy", description: "deploy" },
      });
      const claimed = await store.claimPlan({
        goalId: "G2054",
        purpose: "initial",
        claimRequestId: "t2058-revision",
        ownerFenceToken: "A".repeat(22),
        expectedGeneration: null,
        author: "planner",
      });
      if (!claimed.ok) throw new Error("plan claim failed");
      const manifest = {
        milestones: [{ key: "deployment", title: "Deployment" }],
        tasks: [
          {
            key: "operator",
            milestoneKey: "deployment",
            headline: "Deploy",
            description: "CQ-OPERATOR-ACTION v1 t2054-recovery. User deploys.",
          },
        ],
      } satisfies PlanDraftManifest;
      const first = await store.publishPlanDraft({
        goalId: "G2054",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        operationId: "t2058-first",
        ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
        author: "planner",
        manifest,
      });
      if (!first.ok) throw new Error("first plan publication failed");
      const taskId = first.acknowledgement.manifest.tasks[0]!.id;
      const created = await materializeOperatorAction(store, {
        taskId,
        expectedOutputIdentity: IDENTITY,
        expectedEvidence: ["probe-v1"],
      });
      await acknowledgeOperatorAction(store, {
        actionId: created.action.id,
        expectedRevision: 1,
        outputIdentity: IDENTITY,
        acknowledgedAt: NOW,
      });
      const replacement = await store.publishPlanDraft({
        goalId: "G2054",
        claimId: claimed.acknowledgement.claimId,
        generation: claimed.acknowledgement.generation,
        operationId: "t2058-replacement",
        ownerFenceToken: claimed.acknowledgement.ownerFenceToken,
        author: "planner",
        manifest,
      });
      if (!replacement.ok) throw new Error("replacement plan publication failed");
      expect(store.fetchItem("tasks", taskId).status).toBe("abandoned");
      await expect(store.reopenItem("tasks", taskId, "planned")).rejects.toThrow(
        /draft|typed operator-action lifecycle/,
      );
      const revised = await reviseOperatorAction(store, {
        actionId: created.action.id,
        expectedRevision: 1,
        expectedOutputIdentity: "/nix/store/recovered",
        expectedEvidence: ["probe-v2"],
        revisedAt: NOW,
        author: "parent",
      });
      expect(revised.task.status).toBe("planned");
      const history = JSON.parse((revised.action.fields["revisionHistory"] as string[])[0]!) as {
        task: { status: string };
      };
      expect(history.task.status).toBe("abandoned");
    } finally {
      await store.dispose();
    }
  });
}
