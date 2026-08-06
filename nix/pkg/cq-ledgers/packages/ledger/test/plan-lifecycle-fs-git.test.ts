import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Full-gate parallel load: git-object (and contended fs lock) fixture staging
// needs a generous per-test wall-clock bound (T1995/T1998 ORCHESTRATION_WAIT_MS
// pattern, D281). Tight SUT invariants below are not timed by this budget.
const ORCHESTRATION_WAIT_MS = 120_000;
// How long to observe that init remains blocked on a held lock before we
// release it. Not a SUT ceiling — only a lower-bound "still waiting" sample.
const LOCK_HELD_OBSERVE_MS = 250;
import {
  DECISIONS_LEDGER,
  DEFECTS_LEDGER,
  FsLedgerStore,
  GOALS_LEDGER,
  GitObjectLedgerBackend,
  Lockfile,
  ledgerTreePaths,
  MILESTONES_AMBIENT_ID,
  PLAN_REVIEW_DRAFT_FIELD,
  RESEARCHES_LEDGER,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  removeLedgerArtifacts,
  type PlanFinalizeInput,
  type PlanLifecycleStore,
  type PlanReleaseInput,
} from "../src/index.js";

/** A store instance bound to a persistent location shared with its peers. */
type PersistentLifecycleStore = FsLedgerStore | GitObjectLedgerBackend;

/**
 * One persistent storage location that can be opened by SEVERAL store
 * instances — the in-process stand-in for the multi-process topology both
 * persistent backends serve (Q246: one location, many writers). A raw-mutation
 * fence that decides on a store's own cached snapshot instead of the committed
 * state is only observable across two such instances.
 */
interface PersistentLocation {
  open(): Promise<PersistentLifecycleStore>;
  cleanup(): Promise<void>;
}

interface PersistentBackend {
  readonly name: string;
  create(): Promise<PersistentLocation>;
}

const PERSISTENT_BACKENDS: readonly PersistentBackend[] = [
  {
    name: "FsLedgerStore",
    async create() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-fs-peers-"));
      return {
        async open() {
          const store = new FsLedgerStore({ root });
          await store.init();
          return store;
        },
        async cleanup() {
          await fs.rm(root, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: "GitObjectLedgerBackend",
    async create() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-git-peers-"));
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      return {
        async open() {
          const store = new GitObjectLedgerBackend({ repoRoot: root });
          await store.init();
          return store;
        },
        async cleanup() {
          await fs.rm(root, { recursive: true, force: true });
        },
      };
    },
  },
];

const METHODS = [
  "claimPlan",
  "publishPlanDraft",
  "releasePlanClaim",
  "finalizePlan",
] as const satisfies readonly (keyof PlanLifecycleStore)[];

describe("T849 filesystem and Git plan lifecycle capability", () => {
  for (const store of [FsLedgerStore, GitObjectLedgerBackend]) {
    it(`${store.name} exposes the complete guarded lifecycle`, () => {
      for (const method of METHODS) {
        expect(
          typeof (store.prototype as unknown as Record<string, unknown>)[method],
        ).toBe(
          "function",
        );
      }
    });
  }

  it("recovers a decided filesystem claim and its acknowledgement after partial apply", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-fs-recovery-"));
    const docs = path.join(root, ".cq");
    const store = new FsLedgerStore({ root });
    await store.init();
    await seedGoal(store);
    const goalsPath = path.join(docs, "goals.md");
    const beforeGoals = await fs.readFile(goalsPath, "utf8");
    const input = claimInput("recover-claim", "R".repeat(22));
    const first = await store.claimPlan(input);
    expect(first.ok).toBe(true);
    const finalGoals = await fs.readFile(goalsPath, "utf8");
    const state = await fs.readFile(path.join(docs, "plan-lifecycle.json"), "utf8");
    expect(state).not.toContain(input.ownerFenceToken);

    await fs.writeFile(goalsPath, beforeGoals, "utf8");
    await fs.rm(path.join(docs, "plan-lifecycle.json"));
    await fs.writeFile(
      path.join(docs, "plan-lifecycle.pending.json"),
      JSON.stringify({
        state,
        ledgers: { [GOALS_LEDGER]: finalGoals },
      }),
      "utf8",
    );
    await store.dispose();

    const recovered = new FsLedgerStore({ root });
    await recovered.init();
    const replay = await recovered.claimPlan(input);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("expected claim success");
    expect(replay.replayed).toBe(true);
    expect(replay.acknowledgement).toEqual(first.acknowledgement);
    await expect(
      fs.stat(path.join(docs, "plan-lifecycle.pending.json")),
    ).rejects.toThrow();
    await recovered.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }, ORCHESTRATION_WAIT_MS);

  it("recovers one research pause and review-defect batch after partial multi-ledger apply", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-fs-pause-recovery-"));
    const docs = path.join(root, ".cq");
    const ledgerIds = [
      DEFECTS_LEDGER,
      GOALS_LEDGER,
      RESEARCHES_LEDGER,
      REVIEWS_LEDGER,
    ] as const;
    const store = new FsLedgerStore({ root });
    await store.init();
    await seedGoal(store);
    const claim = await store.claimPlan(
      claimInput("recover-pause-claim", "P".repeat(22)),
    );
    if (!claim.ok) throw new Error("expected claim success");
    const beforeState = await fs.readFile(
      path.join(docs, "plan-lifecycle.json"),
      "utf8",
    );
    const beforeLedgers = Object.fromEntries(
      await Promise.all(
        ledgerIds.map(async (ledgerId) => [
          ledgerId,
          await fs.readFile(path.join(docs, `${ledgerId}.md`), "utf8"),
        ]),
      ),
    ) as Record<(typeof ledgerIds)[number], string>;
    const input: Extract<PlanReleaseInput, { kind: "pause" }> = {
      kind: "pause",
      goalId: "G1",
      claimId: claim.acknowledgement.claimId,
      generation: claim.acknowledgement.generation,
      operationId: "recover-pause",
      ownerFenceToken: "P".repeat(22),
      author: "planner",
      session: "planner-session",
      effect: {
        kind: "researches",
        researches: [
          {
            key: "recovery-probe",
            question: "Does recovery preserve the complete pause?",
            scope: "Exercise a partial multi-ledger filesystem apply",
          },
        ],
      },
      reviewDefects: {
        reviewId: "R1",
        defects: [
          {
            key: "recovery-defect",
            headline: "Recover the complete pause batch",
            severity: "high",
          },
        ],
      },
    };
    const first = await store.releasePlanClaim(input);
    if (!first.ok || first.acknowledgement.kind !== "researches") {
      throw new Error("expected research pause success");
    }
    const finalState = await fs.readFile(
      path.join(docs, "plan-lifecycle.json"),
      "utf8",
    );
    const finalLedgers = Object.fromEntries(
      await Promise.all(
        ledgerIds.map(async (ledgerId) => [
          ledgerId,
          await fs.readFile(path.join(docs, `${ledgerId}.md`), "utf8"),
        ]),
      ),
    ) as Record<(typeof ledgerIds)[number], string>;
    await store.dispose();

    for (const ledgerId of ledgerIds) {
      await fs.writeFile(
        path.join(docs, `${ledgerId}.md`),
        beforeLedgers[ledgerId],
        "utf8",
      );
    }
    await fs.writeFile(path.join(docs, "plan-lifecycle.json"), beforeState, "utf8");
    for (const partiallyApplied of [RESEARCHES_LEDGER, DEFECTS_LEDGER]) {
      await fs.writeFile(
        path.join(docs, `${partiallyApplied}.md`),
        finalLedgers[partiallyApplied],
        "utf8",
      );
    }
    await fs.writeFile(
      path.join(docs, "plan-lifecycle.pending.json"),
      JSON.stringify({ state: finalState, ledgers: finalLedgers }),
      "utf8",
    );

    const recovered = new FsLedgerStore({ root });
    await recovered.init();
    const replay = await recovered.releasePlanClaim(input);
    expect(replay).toEqual({ ...first, replayed: true });
    if (!replay.ok || replay.acknowledgement.kind !== "researches") {
      throw new Error("expected exact research pause replay");
    }
    expect(replay.acknowledgement.researches).toEqual(
      first.acknowledgement.researches,
    );
    expect(replay.acknowledgement.reviewDefects).toEqual(
      first.acknowledgement.reviewDefects,
    );
    expect(replay.acknowledgement.goalPhase).toBe("planning");
    expect(replay.acknowledgement.waitingResearches).toEqual(
      replay.acknowledgement.researches.map(({ id }) => id),
    );
    const goal = recovered.fetchItem(GOALS_LEDGER, "G1");
    expect(goal.status).toBe("planning");
    expect(goal.fields["waitingResearches"]).toEqual(
      replay.acknowledgement.waitingResearches,
    );
    const researches = recovered
      .fetch(RESEARCHES_LEDGER)
      .milestones.flatMap(({ items }) => items);
    const defects = recovered
      .fetch(DEFECTS_LEDGER)
      .milestones.flatMap(({ items }) => items);
    expect(researches.map(({ id }) => id)).toEqual([
      replay.acknowledgement.researches[0]!.id,
    ]);
    expect(defects.map(({ id }) => id)).toEqual([
      replay.acknowledgement.reviewDefects[0]!.id,
    ]);
    expect(
      JSON.stringify(await recovered.releasePlanClaim(input)),
    ).toBe(JSON.stringify(replay));
    expect(
      await fs.readFile(path.join(docs, "plan-lifecycle.json"), "utf8"),
    ).not.toContain(input.ownerFenceToken);
    await expect(
      fs.stat(path.join(docs, "plan-lifecycle.pending.json")),
    ).rejects.toThrow();
    await recovered.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }, ORCHESTRATION_WAIT_MS);

  it("recovers one finalize decision and defect batch before the marker after partial apply", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-fs-finalize-recovery-"));
    const docs = path.join(root, ".cq");
    const ledgerIds = [
      DECISIONS_LEDGER,
      DEFECTS_LEDGER,
      GOALS_LEDGER,
      REVIEWS_LEDGER,
      TASKS_LEDGER,
    ] as const;
    const store = new FsLedgerStore({ root });
    await store.init();
    await seedGoal(store);
    const claim = await store.claimPlan(
      claimInput("recover-finalize-claim", "F".repeat(22)),
    );
    if (!claim.ok) throw new Error("expected claim success");
    const publish = await store.publishPlanDraft({
      goalId: "G1",
      claimId: claim.acknowledgement.claimId,
      generation: claim.acknowledgement.generation,
      operationId: "recover-finalize-publish",
      ownerFenceToken: "F".repeat(22),
      author: "planner",
      session: "planner-session",
      manifest: {
        milestones: [{ key: "delivery", title: "Delivery" }],
        tasks: [
          { key: "implementation", milestoneKey: "delivery", headline: "Implementation" },
        ],
      },
    });
    if (!publish.ok) throw new Error("expected publish success");
    const draft = {
      goalId: "G1",
      claimId: claim.acknowledgement.claimId,
      generation: claim.acknowledgement.generation,
      revision: publish.acknowledgement.manifest.revision,
    };
    await store.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "R1",
      status: "go-ahead",
      fields: {
        summary: "approved",
        [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify(draft),
        ledgerRefs: [`${GOALS_LEDGER}:G1`],
      },
      author: "reviewer",
      session: "reviewer-session",
    });
    const beforeState = await fs.readFile(
      path.join(docs, "plan-lifecycle.json"),
      "utf8",
    );
    const beforeLedgers = Object.fromEntries(
      await Promise.all(
        ledgerIds.map(async (ledgerId) => [
          ledgerId,
          await fs.readFile(path.join(docs, `${ledgerId}.md`), "utf8"),
        ]),
      ),
    ) as Record<(typeof ledgerIds)[number], string>;
    const input: PlanFinalizeInput = {
      goalId: "G1",
      claimId: claim.acknowledgement.claimId,
      generation: claim.acknowledgement.generation,
      operationId: "recover-finalize",
      ownerFenceToken: "F".repeat(22),
      author: "planner",
      session: "planner-session",
      reviewId: "R1",
      draftRevision: draft.revision,
      decision: {
        headline: "Recover the complete finalize",
        rationale: "Exercise a filesystem retry across the finalized marker",
      },
      reviewDefects: {
        reviewId: "R1",
        defects: [
          {
            key: "finalize-defect",
            headline: "Recover the finalize defect batch",
            severity: "medium",
          },
        ],
      },
    };
    const first = await store.finalizePlan(input);
    if (!first.ok) throw new Error("expected finalize success");
    const finalState = await fs.readFile(
      path.join(docs, "plan-lifecycle.json"),
      "utf8",
    );
    const finalLedgers = Object.fromEntries(
      await Promise.all(
        ledgerIds.map(async (ledgerId) => [
          ledgerId,
          await fs.readFile(path.join(docs, `${ledgerId}.md`), "utf8"),
        ]),
      ),
    ) as Record<(typeof ledgerIds)[number], string>;
    await store.dispose();

    // Roll every touched ledger + the lifecycle state back to BEFORE the
    // finalize, then apply only the decision + defect writes: the decision is
    // durable, the finalized marker (goals.md) is not — the create-before-
    // marker ordering the retry must recover from without duplicating.
    for (const ledgerId of ledgerIds) {
      await fs.writeFile(
        path.join(docs, `${ledgerId}.md`),
        beforeLedgers[ledgerId],
        "utf8",
      );
    }
    await fs.writeFile(path.join(docs, "plan-lifecycle.json"), beforeState, "utf8");
    for (const partiallyApplied of [DECISIONS_LEDGER, DEFECTS_LEDGER]) {
      await fs.writeFile(
        path.join(docs, `${partiallyApplied}.md`),
        finalLedgers[partiallyApplied],
        "utf8",
      );
    }
    await fs.writeFile(
      path.join(docs, "plan-lifecycle.pending.json"),
      JSON.stringify({ state: finalState, ledgers: finalLedgers }),
      "utf8",
    );

    const recovered = new FsLedgerStore({ root });
    await recovered.init();
    const replay = await recovered.finalizePlan(input);
    expect(replay).toEqual({ ...first, replayed: true });
    if (!replay.ok) throw new Error("expected exact finalize replay");
    // ONE decision — the retry REUSES the recovered one, never duplicates it.
    expect(replay.acknowledgement.decisionId).toBe(first.acknowledgement.decisionId);
    const decisions = recovered
      .fetch(DECISIONS_LEDGER)
      .milestones.flatMap(({ items }) => items);
    expect(decisions.map(({ id }) => id)).toEqual([first.acknowledgement.decisionId]);
    // ONE defect batch, with the review-side link recovered too.
    const defects = recovered
      .fetch(DEFECTS_LEDGER)
      .milestones.flatMap(({ items }) => items);
    expect(defects.map(({ id }) => id)).toEqual(
      first.acknowledgement.reviewDefects.map(({ id }) => id),
    );
    // ONE executable manifest; the claim's authority is released.
    const goal = recovered.fetchItem(GOALS_LEDGER, "G1");
    expect(goal.status).toBe("planned");
    expect(goal.fields["planActiveClaim"]).toBeUndefined();
    expect(goal.fields["milestones"]).toEqual(
      first.acknowledgement.manifest.milestones.map(({ id }) => id),
    );
    expect(JSON.parse(goal.fields["planFinalizedManifest"] as string)).toEqual(
      first.acknowledgement.manifest,
    );
    expect(JSON.parse(goal.fields["planFinalizedDraft"] as string)).toEqual(draft);
    // A second retry stays a pure replay.
    expect(JSON.stringify(await recovered.finalizePlan(input))).toBe(
      JSON.stringify(replay),
    );
    await expect(
      fs.stat(path.join(docs, "plan-lifecycle.pending.json")),
    ).rejects.toThrow();
    await recovered.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }, ORCHESTRATION_WAIT_MS);

  it("adopts an old filesystem store with no private lifecycle state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-fs-old-store-"));
    const old = new FsLedgerStore({ root });
    await old.init();
    await seedGoal(old);
    await old.dispose();
    await expect(
      fs.stat(path.join(root, ".cq", "plan-lifecycle.json")),
    ).rejects.toThrow();

    const adopted = new FsLedgerStore({ root });
    await adopted.init();
    expect((await adopted.claimPlan(claimInput("old-store", "O".repeat(22)))).ok).toBe(
      true,
    );
    await adopted.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }, ORCHESTRATION_WAIT_MS);

  it("restores verifier-only lifecycle state with exact replay authority", async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "plan-fs-source-"));
    const restoredRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-fs-restore-"));
    const store = new FsLedgerStore({ root: source });
    await store.init();
    await seedGoal(store);
    const input = claimInput("restore-claim", "S".repeat(22));
    const first = await store.claimPlan(input);
    await store.dispose();
    const sourceDocs = path.join(source, ".cq");
    const restoredDocs = path.join(restoredRoot, ".cq");
    await fs.writeFile(
      path.join(sourceDocs, "plan-lifecycle.pending.json"),
      '{"state":"interrupted"}',
      "utf8",
    );
    const portablePaths = await ledgerTreePaths(sourceDocs);
    expect(portablePaths).toContain("plan-lifecycle.json");
    expect(portablePaths).not.toContain("plan-lifecycle.pending.json");
    for (const relativePath of portablePaths) {
      const destination = path.join(restoredDocs, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(sourceDocs, relativePath), destination);
    }

    const restored = new FsLedgerStore({ root: restoredRoot });
    await restored.init();
    const replay = await restored.claimPlan(input);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("expected claim success");
    expect(replay.replayed).toBe(true);
    expect(replay.acknowledgement).toEqual(first.acknowledgement);
    expect(
      await fs.readFile(
        path.join(restoredRoot, ".cq", "plan-lifecycle.json"),
        "utf8",
      ),
    ).not.toContain(input.ownerFenceToken);
    await restored.dispose();
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(restoredRoot, { recursive: true, force: true });
  }, ORCHESTRATION_WAIT_MS);

  it("erases durable and pending filesystem lifecycle state as ledger-owned artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-fs-erase-"));
    const docs = path.join(root, ".cq");
    const store = new FsLedgerStore({ root });
    await store.init();
    await seedGoal(store);
    expect((await store.claimPlan(claimInput("erase-claim", "E".repeat(22)))).ok).toBe(
      true,
    );
    await store.dispose();
    await fs.writeFile(
      path.join(docs, "plan-lifecycle.pending.json"),
      '{"state":"interrupted"}',
      "utf8",
    );

    const erased = await removeLedgerArtifacts(docs);
    expect(erased.removed.map((entry) => path.basename(entry))).toContain(
      "plan-lifecycle.json",
    );
    expect(erased.removed.map((entry) => path.basename(entry))).toContain(
      "plan-lifecycle.pending.json",
    );
    expect(erased.docsDirRemoved).toBe(true);
    await expect(fs.stat(docs)).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  }, ORCHESTRATION_WAIT_MS);

  it("publishes Git lifecycle state and goal marker in one CAS ref advance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-git-cas-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const store = new GitObjectLedgerBackend({ repoRoot: root });
    await store.init();
    await seedGoal(store);
    const before = execFileSync(
      "git",
      ["rev-parse", "refs/heads/cq-ledger"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    const input = claimInput("git-claim", "G".repeat(22));
    expect((await store.claimPlan(input)).ok).toBe(true);
    const after = execFileSync(
      "git",
      ["rev-parse", "refs/heads/cq-ledger"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    expect(after).not.toBe(before);
    const paths = execFileSync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", after],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .sort();
    expect(paths).toEqual(["goals.md", "plan-lifecycle.json"]);
    const privateState = execFileSync(
      "git",
      ["show", "refs/heads/cq-ledger:plan-lifecycle.json"],
      { cwd: root, encoding: "utf8" },
    );
    expect(privateState).not.toContain(input.ownerFenceToken);
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }, ORCHESTRATION_WAIT_MS);

  it("replays an interrupted commit at init inside the ordered lock set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-fs-locked-recovery-"));
    const docs = path.join(root, ".cq");
    const goalsPath = path.join(docs, "goals.md");
    const statePath = path.join(docs, "plan-lifecycle.json");
    const pendingPath = path.join(docs, "plan-lifecycle.pending.json");
    const store = new FsLedgerStore({ root });
    await store.init();
    await seedGoal(store);
    const beforeGoals = await fs.readFile(goalsPath, "utf8");
    const input = claimInput("locked-recovery", "L".repeat(22));
    expect((await store.claimPlan(input)).ok).toBe(true);
    const finalGoals = await fs.readFile(goalsPath, "utf8");
    const state = await fs.readFile(statePath, "utf8");
    await store.dispose();

    // Roll the durable bytes back to the pre-commit state and leave the pending
    // marker an interrupted writer would have left behind.
    await fs.writeFile(goalsPath, beforeGoals, "utf8");
    await fs.rm(statePath);
    await fs.writeFile(
      pendingPath,
      JSON.stringify({ state, ledgers: { [GOALS_LEDGER]: finalGoals } }),
      "utf8",
    );

    // A peer holds the goals lock. Init-time recovery replays a commit that
    // rewrites goals.md, so it MUST wait for that lock exactly as
    // runPlanLifecycleMutation does — otherwise it can overwrite a newer
    // committed state with the superseded pending payload.
    const release = await new Lockfile({}).acquire(
      path.join(docs, ".locks"),
      GOALS_LEDGER,
    );
    const recovered = new FsLedgerStore({ root });
    let settled = false;
    const initialising = recovered.init().then(() => {
      settled = true;
    });
    await Bun.sleep(LOCK_HELD_OBSERVE_MS);
    expect(settled).toBe(false);
    expect(await fs.readFile(pendingPath, "utf8")).toContain(GOALS_LEDGER);
    expect(await fs.readFile(goalsPath, "utf8")).toBe(beforeGoals);

    await release();
    await initialising;
    expect(settled).toBe(true);
    await expect(fs.stat(pendingPath)).rejects.toThrow();
    expect(await fs.readFile(goalsPath, "utf8")).toBe(finalGoals);
    const replay = await recovered.claimPlan(input);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("expected claim success");
    expect(replay.replayed).toBe(true);
    await recovered.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }, ORCHESTRATION_WAIT_MS);

  it("surfaces malformed durable and pending lifecycle state as a LedgerError", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-fs-malformed-"));
    const docs = path.join(root, ".cq");
    const statePath = path.join(docs, "plan-lifecycle.json");
    const pendingPath = path.join(docs, "plan-lifecycle.pending.json");
    const store = new FsLedgerStore({ root });
    await store.init();
    await seedGoal(store);
    expect((await store.claimPlan(claimInput("malformed", "M".repeat(22)))).ok).toBe(
      true,
    );
    await store.dispose();

    // A truncated durable state file must not escape as a raw SyntaxError.
    const durable = await fs.readFile(statePath, "utf8");
    await fs.writeFile(statePath, durable.slice(0, durable.length - 5), "utf8");
    await expect(new FsLedgerStore({ root }).init()).rejects.toThrow(
      /invalid persisted plan lifecycle state/,
    );

    await fs.writeFile(statePath, durable, "utf8");
    await fs.writeFile(pendingPath, '{"state":"truncated"', "utf8");
    await expect(new FsLedgerStore({ root }).init()).rejects.toThrow(
      /invalid pending plan lifecycle commit/,
    );
    await fs.rm(root, { recursive: true, force: true });
  }, ORCHESTRATION_WAIT_MS);
});

describe("T849 raw plan fence across peers on one persistent location", () => {
  for (const backend of PERSISTENT_BACKENDS) {
    it(`${backend.name} fences raw managed-task writes on the committed goal state`, async () => {
      const location = await backend.create();
      const first = await location.open();
      const second = await location.open();
      try {
        await seedGoal(first);
        const task = await first.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
          status: "done",
          fields: {
            headline: "raw managed work",
            ledgerRefs: [`${GOALS_LEDGER}:G1`],
          },
          author: "seed",
          session: "seed-session",
        });

        // The peer promotes G1 into a MANAGED plan goal through the lifecycle
        // API. `first` never re-reads goals on its own, so its cached snapshot
        // still shows an unmanaged goal.
        expect(
          (await second.claimPlan(claimInput("peer-claim", "C".repeat(22)))).ok,
        ).toBe(true);

        await expect(
          first.createItem(TASKS_LEDGER, MILESTONES_AMBIENT_ID, {
            status: "planned",
            fields: {
              headline: "raw follow-up",
              ledgerRefs: [`${GOALS_LEDGER}:G1`],
            },
            author: "raw",
            session: "raw-session",
          }),
        ).rejects.toThrow(/only through PlanLifecycleStore/);
        await expect(
          first.updateItem(TASKS_LEDGER, task.id, { fields: { ledgerRefs: [] } }),
        ).rejects.toThrow(/only through PlanLifecycleStore/);
        await expect(
          first.reopenItem(TASKS_LEDGER, task.id, "planned"),
        ).rejects.toThrow(/draft or superseded/);
      } finally {
        await first.dispose();
        await second.dispose();
        await location.cleanup();
      }
    }, ORCHESTRATION_WAIT_MS);
  }
});

async function seedGoal(
  store: FsLedgerStore | GitObjectLedgerBackend,
): Promise<void> {
  await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: "G1",
    status: "clarifying",
    fields: {
      title: "persistent lifecycle",
      description: "T849 targeted fixture",
    },
    author: "seed",
    session: "seed-session",
  });
}

function claimInput(
  claimRequestId: string,
  ownerFenceToken: string,
): Parameters<PlanLifecycleStore["claimPlan"]>[0] {
  return {
    goalId: "G1",
    purpose: "initial",
    claimRequestId,
    ownerFenceToken,
    expectedGeneration: null,
    author: "planner",
    session: "planner-session",
  };
}
