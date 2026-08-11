import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  InMemoryLedgerStore,
  LedgerError,
  OperatorActionConflictError,
  OperatorActionEnvelopeError,
  SqliteLedgerStore,
  acknowledgeOperatorAction,
  completeOperatorActionTask,
  derivePredicates,
  materializeOperatorAction,
  parseOperatorActionEnvelope,
  recordOperatorActionEvidence,
  type LedgerStore,
} from "../src/index.js";

const NOW = "2026-08-11T06:00:00.000Z";
const IDENTITY = "/nix/store/exact-cq";
const dirs: string[] = [];

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

for (const factory of factories) {
  describe(`operator-action lifecycle (${factory.name})`, () => {
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
          completeOperatorActionTask(store, first.action.id, "premature", { author: "parent" }),
        ).rejects.toBeInstanceOf(LedgerError);

        const acknowledged = await acknowledgeOperatorAction(store, {
          actionId: first.action.id,
          outputIdentity: IDENTITY,
          acknowledgedAt: NOW,
        });
        expect(acknowledged.state).toBe("acknowledged");
        const failedProbe = await recordOperatorActionEvidence(
          store,
          first.action.id,
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
          outputIdentity: IDENTITY,
          acknowledgedAt: NOW,
        });
        const firstProbe = await recordOperatorActionEvidence(
          store,
          first.action.id,
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
          outputIdentity: IDENTITY,
          acknowledgedAt: NOW,
        });
        const stillAcknowledged = await recordOperatorActionEvidence(
          store,
          first.action.id,
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
            outputIdentity: IDENTITY,
            acknowledgedAt: NOW,
          }),
        ).toMatchObject({ state: "verified", action: { status: "verified" } });
        expect(store.fetchItem("tasks", task.id).status).toBe("planned");
        const completed = await completeOperatorActionTask(
          store,
          first.action.id,
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

    test("rejects malformed and duplicate envelopes while ordinary tasks remain unchanged", async () => {
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
        await expect(
          store.createItem("tasks", milestone.id, {
            status: "planned",
            fields: {
              headline: "bad",
              description: "prefix CQ-OPERATOR-ACTION v1 action.",
              ledgerRefs: [`goals:${goal.id}`],
            },
          }),
        ).rejects.toBeInstanceOf(OperatorActionEnvelopeError);
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
              description:
                "CQ-OPERATOR-ACTION v1 action. CQ-OPERATOR-ACTION v1 second.",
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
    expect(
      store.fetch("handoffs").milestones.flatMap((group) => group.items),
    ).toHaveLength(1);
  } finally {
    await store.dispose();
  }
});
