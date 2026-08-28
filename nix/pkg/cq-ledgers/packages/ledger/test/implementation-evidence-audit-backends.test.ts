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
  type ImplementationEvidenceStore,
  type ImplementationReviewerIdentity,
  type PackagedImplementationAuditManifest,
} from "../src/index.js";

const BASE = "a".repeat(40);
const RESULT = "b".repeat(40);
const HEAD = "c".repeat(40);
const identity: ImplementationReviewerIdentity = {
  alias: "adapter",
  harness: "pi",
  model: "frontier",
  provider: "provider",
  effort: null,
  launch: "adapter",
  adapterId: "pi:adapter",
};
const manifest: PackagedImplementationAuditManifest = {
  version: 1,
  manifestId: "backend-contract-v1",
  sourceDigest: "d".repeat(64),
  records: [
    {
      recordKey: "T30",
      taskRef: "tasks:T30",
      ownerGoalRef: "goals:G1",
      finalizedManifest: "manifest",
      historicalReview: null,
      baseCommit: BASE,
      resultCommit: RESULT,
      repositoryHead: HEAD,
      diff: "diff",
      acceptance: "acceptance",
      gateObservations: { exitCode: 0, passCount: 1 },
      requiredObservations: ["commit-retained"],
    },
  ],
  activation: null,
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

function service(store: ImplementationEvidenceStore): ImplementationEvidenceService {
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
      status: "done",
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
});
