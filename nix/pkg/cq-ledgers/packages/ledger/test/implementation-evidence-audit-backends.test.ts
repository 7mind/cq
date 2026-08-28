import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ImplementationEvidenceService,
  createFsImplementationEvidenceStore,
  createInMemoryImplementationEvidenceStore,
  implementationAuditManifestDigest,
  type ImplementationEvidenceServiceDependencies,
  type ImplementationEvidenceFaultBoundary,
  type ImplementationEvidenceStore,
  type ImplementationReviewerIdentity,
  type PackagedImplementationAuditManifest,
} from "../src/index.js";

const BASE = "a".repeat(40);
const RESULT = "b".repeat(40);
const RESULT_TWO = "e".repeat(40);
const HEAD = "c".repeat(40);
const FINALIZED_MANIFEST_DIGEST = "f".repeat(64);
const identity: ImplementationReviewerIdentity = {
  alias: "adapter",
  harness: "pi",
  model: "frontier",
  provider: "provider",
  effort: null,
  launch: "adapter",
  adapterId: "pi:adapter",
};
function historicalReview(taskId: string, resultCommit: string) {
  return {
    taskId,
    verdict: "approve",
    criticism: [],
    questions: [],
    defects: [],
    rationale: "authenticated historical review",
    gateReRan: true,
    gateDurationMs: 10,
    resultCommitVerified: true,
    resultCommitEvidence: { status: "verified", resultCommit, branchTip: resultCommit },
    baseAncestry: {
      status: "verified",
      relation: "descendant",
      baseCommit: BASE,
      resultCommit,
      mergeBase: BASE,
    },
  } as const;
}

function auditRecord(taskId: string, resultCommit: string) {
  return {
    recordKey: taskId,
    taskRef: `tasks:${taskId}`,
    ownerGoalRef: "goals:G1",
    finalizedManifest: "manifest",
    historicalReview: historicalReview(taskId, resultCommit),
    baseCommit: BASE,
    resultCommit,
    repositoryHead: HEAD,
    diff: "diff",
    acceptance: "acceptance",
    gateObservations: { exitCode: 0, passCount: 1 },
    requiredObservations: ["commit-retained"],
  } as const;
}

const manifest: PackagedImplementationAuditManifest = {
  version: 1,
  manifestId: "backend-contract-v1",
  sourceDigest: "d".repeat(64),
  records: [auditRecord("T30", RESULT), auditRecord("T31", RESULT_TWO)],
  activation: {
    goalRef: "goals:G1",
    finalizedManifestDigest: FINALIZED_MANIFEST_DIGEST,
    evidenceTaskKey: "t-evidence",
    auditTaskKey: "t-historical-evidence",
    activationTaskKey: "t-activate-evidence",
  },
};

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("test journal payload must be JSON");
}

function journalDigest(payload: unknown): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

function service(
  store: ImplementationEvidenceStore,
  faultInjector?: ImplementationEvidenceServiceDependencies["faultInjector"],
): ImplementationEvidenceService {
  const dependencies: ImplementationEvidenceServiceDependencies = {
    store,
    resolveReviewerRoster: () => [identity],
    resolveAuditRoster: () => [identity],
    nativeFallback: { ...identity, launch: "native", adapterId: "pi:native" },
    prepareNativeReview: async () => {
      throw new Error("not configured");
    },
    fetchNativeReview: async () => ({ state: "missing" }),
    executeExternalReview: async () => {
      throw new Error("not configured");
    },
    fetchWorker: async () => ({ state: "missing" }),
    readTaskAuthority: async (taskRef) => ({
      taskRef,
      ownerGoalRef: "goals:G1",
      status: taskRef === "tasks:T32" ? "planned" : "done",
      finalizedManifest: "manifest",
    }),
    repositoryHead: async () => HEAD,
    verifyImplementation: async () => {
      throw new Error("not configured");
    },
    recordLedgerCompletion: async () => {
      throw new Error("not configured");
    },
    readAuditManifest: async () => structuredClone(manifest),
    isCommitRetained: async () => true,
    resolveActivationCohort: async () => ({
      finalizedManifestDigest: FINALIZED_MANIFEST_DIGEST,
      evidenceTaskRef: "tasks:T30",
      auditTaskRef: "tasks:T31",
      activationTaskRef: "tasks:T32",
      boundaryCommit: HEAD,
      taskRefs: ["tasks:T30", "tasks:T31"],
    }),
    ...(faultInjector === undefined ? {} : { faultInjector }),
  };
  return new ImplementationEvidenceService(dependencies);
}

async function contract(store: ImplementationEvidenceStore): Promise<string> {
  const panel = await service(store).prepareAuditPanel({
    manifestId: manifest.manifestId,
    manifestDigest: implementationAuditManifestDigest(manifest),
    recordKey: "T30",
    expectedRepositoryHead: HEAD,
    operationId: "prepare-panel",
    author: "parent",
  });
  expect(panel.status).toBe("prepared");
  return panel.panelRef;
}

const applicationBoundaries = [
  "before-implementation-audit-write",
  "before-activation-write",
  "before-activation-requirement-fulfillment-write",
  "before-audit-manifest-application-write",
] as const satisfies readonly ImplementationEvidenceFaultBoundary[];

async function applicationFaultContract(
  createStore: () => Promise<ImplementationEvidenceStore>,
): Promise<void> {
  {
    const store = await createStore();
    let failAt: ImplementationEvidenceFaultBoundary | null =
      "before-activation-requirement-write";
    const subject = service(store, (boundary) => {
      if (boundary === failAt) throw new Error(`injected ${boundary}`);
    });
    const arm = {
      goalRef: "goals:G1",
      manifestId: manifest.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-fault-contract",
      author: "parent",
    } as const;
    await expect(subject.armEvidenceActivation(arm)).rejects.toThrow(
      "injected before-activation-requirement-write",
    );
    expect(Object.keys((await store.snapshot()).activationRequirements)).toHaveLength(0);
    failAt = null;
    await expect(subject.armEvidenceActivation(arm)).resolves.toMatchObject({ status: "armed" });
  }

  for (const boundary of applicationBoundaries) {
    const store = await createStore();
    let failAt: ImplementationEvidenceFaultBoundary | null = null;
    const subject = service(store, (observed) => {
      if (observed === failAt) throw new Error(`injected ${observed}`);
    });
    await subject.armEvidenceActivation({
      goalRef: "goals:G1",
      manifestId: manifest.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: `arm-${boundary}`,
      author: "parent",
    });
    const apply = {
      manifestId: manifest.manifestId,
      manifestDigest: implementationAuditManifestDigest(manifest),
      expectedRepositoryHead: HEAD,
      auditAttemptRefs: [],
      operationId: `apply-${boundary}`,
      author: "parent",
    } as const;
    failAt = boundary;
    await expect(subject.applyAuditManifest(apply)).rejects.toThrow(`injected ${boundary}`);
    const failed = await store.snapshot();
    expect(Object.keys(failed.implementationAudits)).toHaveLength(0);
    expect(Object.keys(failed.activations)).toHaveLength(0);
    expect(Object.keys(failed.auditManifestApplications)).toHaveLength(0);
    expect(Object.values(failed.activationRequirements)).toMatchObject([{ state: "armed" }]);
    failAt = null;
    await expect(subject.applyAuditManifest(apply)).resolves.toMatchObject({
      status: "applied",
      activation: "activated",
    });
  }

  {
    const store = await createStore();
    let failAt: ImplementationEvidenceFaultBoundary | null = null;
    const subject = service(store, (boundary) => {
      if (boundary === failAt) throw new Error(`injected ${boundary}`);
    });
    await subject.armEvidenceActivation({
      goalRef: "goals:G1",
      manifestId: manifest.manifestId,
      expectedRepositoryHead: HEAD,
      operationId: "arm-response-loss",
      author: "parent",
    });
    const apply = {
      manifestId: manifest.manifestId,
      manifestDigest: implementationAuditManifestDigest(manifest),
      expectedRepositoryHead: HEAD,
      auditAttemptRefs: [],
      operationId: "apply-response-loss",
      author: "parent",
    } as const;
    failAt = "after-audit-manifest-application-commit";
    await expect(subject.applyAuditManifest(apply)).rejects.toThrow(
      "injected after-audit-manifest-application-commit",
    );
    const committed = await store.snapshot();
    expect(Object.keys(committed.implementationAudits)).toHaveLength(2);
    expect(Object.keys(committed.activations)).toHaveLength(1);
    expect(Object.keys(committed.auditManifestApplications)).toEqual([apply.operationId]);
    failAt = null;
    await expect(subject.applyAuditManifest(apply)).resolves.toMatchObject({
      status: "existing",
      activation: "existing",
      taskRefs: ["tasks:T30", "tasks:T31"],
    });
    expect(Object.keys((await store.snapshot()).auditManifestApplications)).toEqual([
      apply.operationId,
    ]);
  }
}

describe("implementation audit store backend contract [Blackbox]", () => {
  test("runs the same append-only contract against the in-memory dummy", async () => {
    const store = createInMemoryImplementationEvidenceStore();
    const panelRef = await contract(store);
    expect((await store.snapshot()).auditPanels[panelRef]).toBeDefined();
  });

  test("runs the same contract against the filesystem journal and survives restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-audit-backend-"));
    temporary.push(root);
    const path = join(root, "journal");
    const panelRef = await contract(createFsImplementationEvidenceStore({ path }));
    expect((await createFsImplementationEvidenceStore({ path }).snapshot()).auditPanels[panelRef])
      .toBeDefined();
  });

  test("loads an authenticated legacy filesystem snapshot without changing its digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-audit-legacy-journal-"));
    temporary.push(root);
    const path = join(root, "journal");
    const snapshot = { version: 1, panels: {}, attempts: {}, completions: {} };
    const payload = {
      kind: "cq-implementation-evidence-journal-entry",
      version: 1,
      sequence: 1,
      priorDigest: null,
      snapshot,
    };
    const digest = journalDigest(payload);
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, `0000000000000001-${digest}.json`),
      `${JSON.stringify({ ...payload, digest })}\n`,
      "utf8",
    );

    await expect(createFsImplementationEvidenceStore({ path }).snapshot()).resolves.toMatchObject({
      auditPanels: {},
      auditAttempts: {},
      implementationAudits: {},
      activationRequirements: {},
      activations: {},
    });
  });

  test("does not append state when trusted packaged resolution fails", async () => {
    const store = createInMemoryImplementationEvidenceStore();
    await expect(
      service(store).prepareAuditPanel({
        manifestId: manifest.manifestId,
        manifestDigest: "0".repeat(64),
        recordKey: "T30",
        expectedRepositoryHead: HEAD,
        operationId: "bad-digest",
        author: "parent",
      }),
    ).rejects.toThrow("digest changed");
    expect(Object.keys((await store.snapshot()).auditPanels)).toHaveLength(0);
  });

  test("rolls back every application write boundary and replays response loss in memory", async () => {
    await applicationFaultContract(async () => createInMemoryImplementationEvidenceStore());
  });

  test("rolls back every application write boundary and replays response loss after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-audit-application-faults-"));
    temporary.push(root);
    let sequence = 0;
    await applicationFaultContract(async () => {
      sequence += 1;
      return createFsImplementationEvidenceStore({ path: join(root, String(sequence)) });
    });
  });
});
