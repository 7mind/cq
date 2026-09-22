import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorksetGitEffectGate } from "@cq/process-control";
import {
  constructCohortDecisionsV1,
  createCohortDefinitionIdentityV1,
  createCohortCandidateIntentV1,
  createCohortEffectEnvelopeV1,
  type CohortBoundaryIdentityV1,
} from "../src/workCohort.js";
import { createInMemoryWorkCohortStore, type WorkCohortStore } from "../src/workCohortStore.js";
import {
  prepareManagedCohortWorktree,
  nodeManagedWorktreeGitRunner,
  resolveManagedCohortWorktreeDispatchBinding,
  type ManagedCohortWorktreeAuthority,
} from "../src/managedWorktree.js";
import { createCohortWorksetEffectAdmissionProvider } from "../src/workCohortEffects.js";
import { createSqliteWorkCohortStore } from "../src/store/sqlite/sqliteWorkCohortStore.js";
import { openLedgerDb } from "../src/store/sqlite/connection.js";
import { ensureSchema } from "../src/store/sqlite/schema.js";
import { InMemoryLedgerStore } from "../src/store/InMemoryLedgerStore.js";
import type {
  DispatchBoundGitAuthorization,
  GitChangeBrokerRequest,
} from "../src/gitChangeBroker.js";
import type { GitConflictContinuationDeps } from "../src/gitConflictContinuation.js";
import { observationFor } from "./workCohortFixture.js";

export function rawDigest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function cohortBrokerGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await nodeManagedWorktreeGitRunner(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
export async function cohortGitBrokerFixture(backend: "memory" | "sqlite", boundaries?: {
  readonly sharedRegression: CohortBoundaryIdentityV1; readonly canonicalFullGate: CohortBoundaryIdentityV1;
}) {
  const root = await mkdtemp(join(tmpdir(), "cq-cohort-broker-"));
  await cohortBrokerGit(root, ["init", "-q", "-b", "main"]);
  await cohortBrokerGit(root, ["config", "user.name", "Cohort broker"]);
  await cohortBrokerGit(root, ["config", "user.email", "cohort-broker@example.invalid"]);
  await cohortBrokerGit(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "bun.lock"), "{}\n");
  await writeFile(join(root, "a.txt"), "base a\n");
  await writeFile(join(root, "b.txt"), "base b\n");
  await writeFile(join(root, ".gitignore"), ".claude/\n.state/\n.cache/\nnode_modules/\n");
  await cohortBrokerGit(root, ["add", "."]);
  await cohortBrokerGit(root, ["commit", "-q", "-m", "seed"]);
  const baseCommit = await cohortBrokerGit(root, ["rev-parse", "HEAD"]);
  const canonicalRoot = await realpath(root);
  const commonDir = await realpath(
    await cohortBrokerGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const repository = {
    repositoryId: rawDigest(`${canonicalRoot}\n${commonDir}`),
    headCommit: baseCommit,
    treeOid: await cohortBrokerGit(root, ["rev-parse", "HEAD^{tree}"]),
  };
  const observation = await observationFor(["tasks:T1", "tasks:T2"].map((ref) => ({ ref,
    ...(boundaries === undefined ? {} : { atoms: [{ regressionBoundary: boundaries.sharedRegression, gateBoundary: boundaries.canonicalFullGate }] }) })), {
    repository,
  });
  const decision = constructCohortDecisionsV1(observation)[0]!;
  const definition = createCohortDefinitionIdentityV1({
    cohortId: "cohort:broker",
    observation,
    decision,
    prior: null,
  });
  const intent = createCohortCandidateIntentV1(definition, "broker:production");
  await mkdir(join(root, ".state"));
  const db = backend === "sqlite" ? openLedgerDb(join(root, ".state", "ledger.db")) : null;
  if (db !== null) ensureSchema(db);
  const store: WorkCohortStore =
    db === null ? createInMemoryWorkCohortStore() : await createSqliteWorkCohortStore(db);
  await store.recordObservation("observe", observation);
  await store.recordDecision("decide", decision);
  await store.recordDefinition("define", definition);
  await store.recordCandidateIntent("intent", intent);
  await store.transitionReservation("reserve", {
    reservationId: "broker",
    cohortId: definition.cohortId,
    definitionDigest: definition.definitionDigest,
    memberRefs: ["tasks:T1", "tasks:T2"],
    transition: "reserved",
  });
  const makeAuthority = async (holderId: string): Promise<ManagedCohortWorktreeAuthority> => {
    const envelope = createCohortEffectEnvelopeV1({
      definition,
      observation,
      intent,
      evidenceSubject: null,
      executionEpoch: (await store.snapshot()).runtime.executionEpoch,
    });
    return {
      store,
      envelope,
      lease: await store.acquireLease({ holderId, semanticSubject: envelope.semanticSubject }),
    };
  };
  const authority = await makeAuthority("broker");
  const deps = {
    stateDir: join(root, ".state", "registry"),
    cacheRoot: join(root, ".cache"),
    bunWorkspaceRoot: root,
    skipInstall: true,
  };
  const prepared = await prepareManagedCohortWorktree(
    {
      repositoryRoot: root,
      baseCommit,
      handle: null,
      priorResultCommit: null,
      integrationHead: baseCommit,
      dependencyReader: {
        readTaskSnapshots: async () =>
          ["T1", "T2"].map((taskId) => ({
            taskId,
            status: "planned",
            dependsOn: [],
            resultCommit: null,
            archived: false,
            contributionKind: "git-producing" as const,
            operatorAction: null,
          })),
      },
    },
    deps,
    authority,
  );
  if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));
  const binding = await resolveManagedCohortWorktreeDispatchBinding(
    prepared.handle,
    authority,
    deps,
    false,
  );
  if (binding === null) throw new Error("cohort fixture binding did not resolve");
  const authorization: Extract<DispatchBoundGitAuthorization, { readonly cohort: object }> = {
    ...binding,
    attestationId: `att_${"a".repeat(64)}`,
    generation: 1,
    roleId: "implement-worker",
    surface: "codex",
    childCancelAt: "2099-01-01T00:00:00.000Z",
  };
  const ledger = new InMemoryLedgerStore();
  await ledger.init();
  const milestone = await ledger.createMilestone({ title: "cohort broker" });
  for (const taskId of ["T1", "T2"])
    await ledger.createItem("tasks", milestone.id, {
      status: "planned",
      fields: { headline: taskId },
    });
  await ledger.worksetStore().setRoots(["tasks:T1", "tasks:T2"]);
  const runRebaseContinue: NonNullable<GitConflictContinuationDeps["runRebaseContinue"]> = (
    expected,
    resolve,
    environment,
  ) =>
    runWorksetGitEffectGate({
      expected,
      resolve,
      environment,
      provider: createCohortWorksetEffectAdmissionProvider(authority, ledger.worksetStore()),
    });
  return {
    root,
    baseCommit,
    store,
    definition,
    observation,
    intent,
    authority,
    authorization,
    deps,
    prepared,
    ledger,
    runRebaseContinue,
    makeAuthority,
    close: async () => {
      await ledger.dispose();
      if (db !== null) db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function cohortChangeRequest(
  authorization: DispatchBoundGitAuthorization,
  operationId: string,
  name: "a" | "b",
  before: string,
  after: string,
): Promise<GitChangeBrokerRequest> {
  await writeFile(join(authorization.worktreePath, `${name}.txt`), after);
  return {
    authorization,
    operationId,
    expectedHead: await cohortBrokerGit(authorization.worktreePath, ["rev-parse", "HEAD"]),
    message: operationId,
    changes: [
      {
        kind: "modify",
        path: `${name}.txt`,
        oldState: { mode: "100644", digest: rawDigest(before) },
        newState: { mode: "100644", digest: rawDigest(after) },
      },
    ],
  };
}
