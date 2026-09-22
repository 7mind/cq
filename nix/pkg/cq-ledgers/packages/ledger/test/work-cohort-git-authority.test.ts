import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constructCohortDecisionsV1, createCohortDefinitionIdentityV1, createCohortCandidateIntentV1,
  createCohortEffectEnvelopeV1 } from "../src/workCohort.js";
import { createInMemoryWorkCohortStore, type WorkCohortStore } from "../src/workCohortStore.js";
import { prepareManagedCohortWorktree, prepareManagedWorktree, nodeManagedWorktreeGitRunner,
  resolveManagedCohortWorktreeDispatchBinding,
  type ManagedWorktreeDeps, type ManagedCohortWorktreeAuthority } from "../src/managedWorktree.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema } from "../src/store/sqlite/schema.js";
import { createSqliteWorkCohortStore } from "../src/store/sqlite/sqliteWorkCohortStore.js";
import { observationFor } from "./workCohortFixture.js";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import { createManagedCohortWorktreeGitEffectRunner } from "../src/worksetGitEffects.js";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await nodeManagedWorktreeGitRunner(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture(backend: "memory" | "sqlite") {
  const root = await mkdtemp(join(tmpdir(), "cq-cohort-manager-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Cohort test"]);
  await git(root, ["config", "user.email", "cohort@example.invalid"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "package.json"), '{"name":"cohort-test","private":true,"workspaces":[]}');
  await writeFile(join(root, "bun.lock"), "{}\n");
  await writeFile(join(root, ".gitignore"), "node_modules/\n.claude/\n.state/\n.cache/\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "seed"]);
  const baseCommit = await git(root, ["rev-parse", "HEAD"]);
  const canonicalRoot = await realpath(root);
  const commonDir = await realpath(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const repository = { repositoryId: createHash("sha256").update(`${canonicalRoot}\n${commonDir}`).digest("hex"),
    headCommit: baseCommit, treeOid: await git(root, ["rev-parse", "HEAD^{tree}"]) };
  const observation = await observationFor([{ ref: "tasks:T1" }, { ref: "tasks:T2" }], { repository });
  const decision = constructCohortDecisionsV1(observation)[0]!;
  const definition = createCohortDefinitionIdentityV1({ cohortId: "cohort:manager", observation, decision, prior: null });
  const intent = createCohortCandidateIntentV1(definition, "prepare:manager");
  await mkdir(join(root, ".state"));
  const db = backend === "sqlite" ? openLedgerDb(join(root, ".state", "ledger.db")) : null;
  if (db !== null) ensureSchema(db);
  const store: WorkCohortStore = db === null ? createInMemoryWorkCohortStore() : await createSqliteWorkCohortStore(db);
  await store.recordObservation("observe", observation);
  await store.recordDecision("decide", decision);
  await store.recordDefinition("define", definition);
  await store.recordCandidateIntent("intent", intent);
  await store.transitionReservation("reserve", { reservationId: "manager", cohortId: definition.cohortId,
    definitionDigest: definition.definitionDigest, memberRefs: ["tasks:T1", "tasks:T2"], transition: "reserved" });
  const envelope = createCohortEffectEnvelopeV1({ definition, observation, intent, evidenceSubject: null,
    executionEpoch: (await store.snapshot()).runtime.executionEpoch });
  const lease = await store.acquireLease({ holderId: "manager", semanticSubject: envelope.semanticSubject });
  const authority: ManagedCohortWorktreeAuthority = { store, lease, envelope };
  const request = { repositoryRoot: root, baseCommit, handle: null, priorResultCommit: null, integrationHead: baseCommit,
    dependencyReader: { readTaskSnapshots: async () => ["T1", "T2"].map((taskId) => ({ taskId, status: "planned",
      dependsOn: [], resultCommit: null, archived: false, contributionKind: "git-producing" as const, operatorAction: null })) } };
  const deps: ManagedWorktreeDeps = { stateDir: join(root, ".state", "registry"), cacheRoot: join(root, ".cache"),
    bunWorkspaceRoot: root, skipInstall: true };
  return { root, store, observation, definition, intent, authority, request, deps,
    close: async () => { if (db !== null) db.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const backend of ["memory", "sqlite"] as const) describe(`${backend} cohort manager [Behavioral-Active Blackbox-GoodCommunication]`, () => {
  test("one real worktree owns all members; exact replay resumes and every task arm refuses overlap", async () => {
    const f = await fixture(backend);
    try {
      const prepared = await prepareManagedCohortWorktree(f.request, f.deps, f.authority);
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));
      expect(Object.hasOwn(prepared.handle, "taskId")).toBe(false);
      expect(prepared.handle.cohort.memberAuthorities.map((member) => member.taskRef)).toEqual(["tasks:T1", "tasks:T2"]);
      expect(await git(prepared.handle.absolutePath, ["rev-parse", "HEAD"])).toBe(f.request.baseCommit);
      const binding = await resolveManagedCohortWorktreeDispatchBinding(prepared.handle, f.authority, f.deps, false);
      expect(binding).toMatchObject({ cohort: f.authority.envelope, branch: prepared.handle.branch,
        handleToken: prepared.handle.token, baseCommit: f.request.baseCommit });
      expect(Object.hasOwn(binding!, "taskId")).toBe(false);
      expect(await resolveManagedCohortWorktreeDispatchBinding({ ...prepared.handle, nonce: "foreign" }, f.authority, f.deps, false)).toBeNull();
      expect(await prepareManagedCohortWorktree(f.request, f.deps, f.authority)).toMatchObject({
        status: "resume-required", handle: prepared.handle });
      expect(await prepareManagedCohortWorktree({ ...f.request, handle: prepared.handle }, f.deps, f.authority))
        .toMatchObject({ status: "prepared", handle: prepared.handle, evidence: { mode: "resume" } });
      for (const taskId of ["T1", "T2"]) expect(await prepareManagedWorktree({ repositoryRoot: f.root,
        taskId, baseCommit: f.request.baseCommit }, f.deps)).toMatchObject({ status: "refused", reason: "member-reserved" });
      expect(await prepareManagedWorktree({ repositoryRoot: f.root, taskId: "T3", baseCommit: f.request.baseCommit }, f.deps))
        .toMatchObject({ status: "prepared" });
    } finally { await f.close(); }
  });

  test("an existing nonfirst member task worktree blocks the whole prepare before Git mutation", async () => {
    const f = await fixture(backend);
    try {
      expect(await prepareManagedWorktree({ repositoryRoot: f.root, taskId: "T2", baseCommit: f.request.baseCommit }, f.deps))
        .toMatchObject({ status: "prepared" });
      const before = await git(f.root, ["worktree", "list", "--porcelain"]);
      expect(await prepareManagedCohortWorktree(f.request, f.deps, f.authority)).toMatchObject({ status: "refused", reason: "member-reserved" });
      expect(await git(f.root, ["worktree", "list", "--porcelain"])).toBe(before);
    } finally { await f.close(); }
  });

  test("concurrent cohort and nonfirst task prepare cannot publish overlapping trees", async () => {
    const f = await fixture(backend);
    try {
      const results = await Promise.all([
        prepareManagedCohortWorktree(f.request, f.deps, f.authority),
        prepareManagedWorktree({ repositoryRoot: f.root, taskId: "T2", baseCommit: f.request.baseCommit }, f.deps),
      ]);
      expect(results.filter((result) => result.status === "prepared")).toHaveLength(1);
      expect(results.filter((result) => result.status === "refused")).toEqual([expect.objectContaining({ reason: "member-reserved" })]);
    } finally { await f.close(); }
  });

  test("durable reservations deny task preparation before the cohort tree exists", async () => {
    const f = await fixture(backend);
    try {
      expect(await prepareManagedWorktree({ repositoryRoot: f.root, taskId: "T2", baseCommit: f.request.baseCommit },
        { ...f.deps, cohortStore: f.store })).toMatchObject({ status: "refused", reason: "member-reserved" });
    } finally { await f.close(); }
  });

  test("the production Git runner registers one complete cohort target and rejects excluded nonfirst members", async () => {
    const f = await fixture(backend);
    const ledger = new InMemoryLedgerStore();
    await ledger.init();
    try {
      const milestone = await ledger.createMilestone({ title: "cohort Git effect" });
      for (const taskId of ["T1", "T2"]) {
        const item = await ledger.createItem("tasks", milestone.id, { status: "planned", fields: { headline: taskId } });
        expect(item.id).toBe(taskId);
      }
      const deps = { ...f.deps, git: createManagedCohortWorktreeGitEffectRunner({ store: ledger,
        repositoryRoot: f.root, authority: f.authority, readOnlyGit: nodeManagedWorktreeGitRunner }) };
      await ledger.worksetStore().setRoots(["tasks:T1"]);
      const before = await git(f.root, ["worktree", "list", "--porcelain"]);
      await expect(prepareManagedCohortWorktree(f.request, deps, f.authority)).rejects.toThrow("outside the admitted workset");
      expect(await git(f.root, ["worktree", "list", "--porcelain"])).toBe(before);
      expect(ledger.worksetStore().activeAdmissionCount()).toBe(0);
      await ledger.worksetStore().setRoots(["tasks:T1", "tasks:T2"]);
      const prepared = await prepareManagedCohortWorktree(f.request, deps, f.authority);
      expect(prepared.status).toBe("prepared");
      expect(ledger.worksetStore().activeAdmissionCount()).toBe(0);
    } finally { await ledger.dispose(); await f.close(); }
  });

  test("changed authority during installation rolls the allocation back, retaining no published handle", async () => {
    const f = await fixture(backend);
    try {
      const before = await git(f.root, ["worktree", "list", "--porcelain"]);
      const result = await prepareManagedCohortWorktree(f.request, { ...f.deps, skipInstall: false,
        install: async () => { await f.store.beginNewExecutionEpoch(); return { code: 0, stdout: "", stderr: "" }; } }, f.authority);
      expect(result).toMatchObject({ status: "refused", reason: "registry-conflict" });
      expect(await git(f.root, ["worktree", "list", "--porcelain"])).toBe(before);
      expect(await prepareManagedCohortWorktree(f.request, f.deps, f.authority)).toMatchObject({ status: "refused", reason: "cohort-authority-stale" });
    } finally { await f.close(); }
  });

  test("authority rotation during registry staging prevents publication", async () => {
    const f = await fixture(backend);
    try {
      const before = await git(f.root, ["worktree", "list", "--porcelain"]);
      const result = await prepareManagedCohortWorktree(f.request, { ...f.deps,
        faultInjector: async (boundary, context) => {
          if (boundary === "after-registry-generation-sync" && context["subjectKey"] !== undefined) {
            await f.store.beginNewExecutionEpoch();
          }
        } }, f.authority);
      expect(result).toMatchObject({ status: "refused", reason: "registry-conflict" });
      expect(await git(f.root, ["worktree", "list", "--porcelain"])).toBe(before);
    } finally { await f.close(); }
  });

  test("a fault after visible registry publication retains one resumable tree", async () => {
    const f = await fixture(backend);
    try {
      const result = await prepareManagedCohortWorktree(f.request, { ...f.deps,
        faultInjector: async (boundary, context) => {
          if (boundary === "after-registry-pointer-rename" && context["subjectKey"] !== undefined) {
            throw new Error("post-publication fault");
          }
        } }, f.authority);
      expect(result.status).toBe("prepared");
      if (result.status === "prepared") expect(result.evidence.registryPublicationWarning).toContain("post-publication fault");
      const resumed = await prepareManagedCohortWorktree(f.request, f.deps, f.authority);
      expect(resumed.status).toBe("resume-required");
      if (result.status === "prepared" && resumed.status === "resume-required") expect(resumed.handle).toEqual(result.handle);
    } finally { await f.close(); }
  });

  test("epoch renewal preserves the handle while forged membership and foreign repository bindings fail closed", async () => {
    const f = await fixture(backend);
    try {
      const prepared = await prepareManagedCohortWorktree(f.request, f.deps, f.authority);
      if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));
      await f.store.beginNewExecutionEpoch();
      const envelope = createCohortEffectEnvelopeV1({ definition: f.definition, observation: f.observation, intent: f.intent,
        evidenceSubject: null, executionEpoch: (await f.store.snapshot()).runtime.executionEpoch });
      const lease = await f.store.acquireLease({ holderId: "renewed", semanticSubject: envelope.semanticSubject });
      const authority = { store: f.store, lease, envelope };
      expect(await prepareManagedCohortWorktree({ ...f.request, handle: prepared.handle }, f.deps, f.authority))
        .toMatchObject({ status: "refused", reason: "cohort-authority-stale" });
      await expect(resolveManagedCohortWorktreeDispatchBinding(prepared.handle, f.authority, f.deps, false)).rejects.toThrow("execution epoch");
      expect(await prepareManagedCohortWorktree({ ...f.request, handle: prepared.handle }, f.deps, authority))
        .toMatchObject({ status: "prepared", handle: prepared.handle });
      const forged = { ...prepared.handle, cohort: { ...prepared.handle.cohort,
        memberAuthorities: prepared.handle.cohort.memberAuthorities.slice(0, 1) } };
      expect(await prepareManagedCohortWorktree({ ...f.request, handle: forged }, f.deps, authority))
        .toMatchObject({ status: "refused", reason: "handle-mismatch" });
    } finally { await f.close(); }
  });

  test("resume and binding resolution reject an epoch rotated during Git observation", async () => {
    const f = await fixture(backend);
    try {
      const prepared = await prepareManagedCohortWorktree(f.request, f.deps, f.authority);
      if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));
      const deps: ManagedWorktreeDeps = { ...f.deps, git: async (cwd, args) => {
        const result = await nodeManagedWorktreeGitRunner(cwd, args);
        if (cwd === prepared.handle.absolutePath && args.includes("HEAD^{commit}")) await f.store.beginNewExecutionEpoch();
        return result;
      } };
      expect(await prepareManagedCohortWorktree({ ...f.request, handle: prepared.handle }, deps, f.authority))
        .toMatchObject({ status: "refused", reason: "cohort-authority-stale" });
    } finally { await f.close(); }
  });
});
