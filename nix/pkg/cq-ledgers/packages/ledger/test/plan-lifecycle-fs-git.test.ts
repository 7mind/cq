import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FsLedgerStore,
  GOALS_LEDGER,
  GitObjectLedgerBackend,
  ledgerTreePaths,
  MILESTONES_AMBIENT_ID,
  removeLedgerArtifacts,
  type PlanLifecycleStore,
} from "../src/index.js";

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
  });

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
  });

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
  });

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
  });

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
  });
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
