import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ImplementationEvidenceJournalFaultBoundary,
  ImplementationEvidenceJournalPublication,
} from "../src/index.js";

const originalCreateHash = crypto.createHash.bind(crypto);
const originalReadFile = fs.readFile.bind(fs);
const originalReaddir = fs.readdir.bind(fs);
const originalStat = fs.stat.bind(fs);
const originalJsonParse = JSON.parse.bind(JSON);

interface Instrumentation {
  directoryReads: number;
  entryStats: number;
  payloadReads: number;
  payloadBytes: number;
  payloadParses: number;
  entryHashes: number;
  tipHashes: number;
  fixedReads: number;
}

const instrumentation: Instrumentation = {
  directoryReads: 0,
  entryStats: 0,
  payloadReads: 0,
  payloadBytes: 0,
  payloadParses: 0,
  entryHashes: 0,
  tipHashes: 0,
  fixedReads: 0,
};

function resetInstrumentation(): void {
  for (const key of Object.keys(instrumentation) as Array<keyof Instrumentation>) {
    instrumentation[key] = 0;
  }
}

function observedInstrumentation(): Instrumentation {
  return { ...instrumentation };
}

const readdirSpy = spyOn(fs, "readdir").mockImplementation(async (...args: unknown[]) => {
  instrumentation.directoryReads += 1;
  return await (originalReaddir as (...values: unknown[]) => Promise<unknown>)(...args) as never;
});

const statSpy = spyOn(fs, "stat").mockImplementation(async (...args: unknown[]) => {
  if (/\/[0-9]{16}-[0-9a-f]{64}\.json$/u.test(String(args[0]))) {
    instrumentation.entryStats += 1;
  }
  return await (originalStat as (...values: unknown[]) => Promise<unknown>)(...args) as never;
});

const readFileSpy = spyOn(fs, "readFile").mockImplementation(async (...args: unknown[]) => {
  const value = await (originalReadFile as (...values: unknown[]) => Promise<unknown>)(...args);
  const path = String(args[0]);
  if (/\/[0-9]{16}-[0-9a-f]{64}\.json$/u.test(path)) {
    instrumentation.payloadReads += 1;
    instrumentation.payloadBytes +=
      typeof value === "string" ? Buffer.byteLength(value) : (value as Uint8Array).byteLength;
  } else if (path.endsWith("/.format") || path.endsWith("/.tip")) {
    instrumentation.fixedReads += 1;
  }
  return value as never;
});

const jsonParseSpy = spyOn(JSON, "parse").mockImplementation(((value: string) => {
  if (value.startsWith('{"kind":"cq-implementation-evidence-journal-entry"')) {
    instrumentation.payloadParses += 1;
  }
  return originalJsonParse(value);
}) as typeof JSON.parse);

const createHashSpy = spyOn(crypto, "createHash").mockImplementation(
  ((...args: Parameters<typeof crypto.createHash>) => {
    const hash = originalCreateHash(...args);
    const originalUpdate = hash.update.bind(hash);
    const originalDigest = hash.digest.bind(hash);
    let input = "";
    hash.update = ((data: string | NodeJS.ArrayBufferView, ...updateArgs: unknown[]) => {
      input +=
        typeof data === "string"
          ? data
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
      return (originalUpdate as (...values: unknown[]) => typeof hash)(data, ...updateArgs);
    }) as typeof hash.update;
    hash.digest = ((...digestArgs: unknown[]) => {
      if (input.includes('"kind":"cq-implementation-evidence-journal-entry"')) {
        instrumentation.entryHashes += 1;
      }
      if (input.includes('"kind":"cq-implementation-evidence-journal-tip"')) {
        instrumentation.tipHashes += 1;
      }
      return (originalDigest as (...values: unknown[]) => unknown)(...digestArgs);
    }) as typeof hash.digest;
    return hash;
  }) as typeof crypto.createHash,
);

const {
  ImplementationEvidenceService,
  InMemoryLedgerStore,
  QUESTIONS_LEDGER,
  TASKS_LEDGER,
  createFsImplementationEvidenceStore,
  createInMemoryImplementationEvidenceStore,
  createInMemoryWorksetStore,
  createWorksetGenericMutationGateway,
  protectLedgerStoreWithImplementationEvidence,
} = await import("../src/index.js");

afterAll(() => {
  readdirSpy.mockRestore();
  statSpy.mockRestore();
  readFileSpy.mockRestore();
  jsonParseSpy.mockRestore();
  createHashSpy.mockRestore();
});

const REVIEWER = {
  alias: "native",
  harness: "codex",
  model: "frontier",
  provider: null,
  launch: "native",
  adapterId: "codex:native",
} as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function evidenceDigest(value: unknown): string {
  return originalCreateHash("sha256").update(canonicalJson(value)).digest("hex");
}

function serviceFor(store: ReturnType<typeof createFsImplementationEvidenceStore>) {
  return new ImplementationEvidenceService({
    store,
    resolveReviewerRoster: () => [REVIEWER],
    nativeFallback: REVIEWER,
    now: () => "2026-09-21T00:00:00.000Z",
  } as never);
}

async function preparePanel(
  service: InstanceType<typeof ImplementationEvidenceService>,
  taskId: string,
  operationId: string,
): Promise<void> {
  await service.prepareReviewPanel({
    taskRef: `tasks:${taskId}`,
    resultCommit: "b".repeat(40),
    workerDispatch: { attestationId: `att_${taskId}`, generation: 1 },
    operationId,
    author: "probe",
  });
}

async function frozenSnapshot(root: string): Promise<Record<string, unknown>> {
  const bootstrapPath = join(root, "bootstrap");
  const store = createFsImplementationEvidenceStore({ path: bootstrapPath });
  await preparePanel(serviceFor(store), "T2345", "seed-panel");
  const [entryName] = (await readdir(bootstrapPath)).filter((name) => name.endsWith(".json"));
  if (entryName === undefined) throw new Error("bootstrap journal entry is absent");
  const entry = originalJsonParse(
    (await originalReadFile(join(bootstrapPath, entryName), "utf8")) as string,
  ) as { snapshot: Record<string, unknown> };
  return structuredClone(entry.snapshot);
}

async function appendAuthenticatedEntry(
  path: string,
  snapshot: Record<string, unknown>,
  sequence: number,
  priorDigest: string | null,
): Promise<{ readonly digest: string; readonly bytes: number; readonly filename: string }> {
  const payload = {
    kind: "cq-implementation-evidence-journal-entry" as const,
    version: 1 as const,
    sequence,
    priorDigest,
    snapshot,
  };
  const digest = evidenceDigest(payload);
  const body = `${JSON.stringify({ ...payload, digest })}\n`;
  const filename = `${String(sequence).padStart(16, "0")}-${digest}.json`;
  await writeFile(join(path, filename), body, "utf8");
  return { digest, bytes: Buffer.byteLength(body), filename };
}

async function writeAuthenticatedChain(
  path: string,
  snapshot: Record<string, unknown>,
  count: number,
): Promise<{ readonly bytes: number; readonly digest: string | null }> {
  await mkdir(path, { recursive: true });
  let priorDigest: string | null = null;
  let bytes = 0;
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const entry = await appendAuthenticatedEntry(path, snapshot, sequence, priorDigest);
    bytes += entry.bytes;
    priorDigest = entry.digest;
  }
  return { bytes, digest: priorDigest };
}

function storedTip(sequence: number, digest: string | null): Record<string, unknown> {
  const payload = {
    kind: "cq-implementation-evidence-journal-tip" as const,
    version: 1 as const,
    sequence,
    digest,
  };
  return { ...payload, authentication: evidenceDigest(payload) };
}

async function activeJournal(
  path: string,
  snapshot: Record<string, unknown>,
  count: number,
): Promise<ReturnType<typeof createFsImplementationEvidenceStore>> {
  await writeAuthenticatedChain(path, snapshot, count);
  const store = createFsImplementationEvidenceStore({ path });
  await store.snapshot();
  return store;
}

describe("implementation evidence authenticated journal cache", () => {
  test("cold authentication is linear once; warm, local append, and peer reconciliation read only suffix payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-evidence-scaling-"));
    try {
      const snapshot = await frozenSnapshot(root);
      const results: Array<Record<string, unknown>> = [];
      for (const count of [1, 16, 64]) {
        const path = join(root, `journal-${count}`);
        const fixture = await writeAuthenticatedChain(path, snapshot, count);
        const store = createFsImplementationEvidenceStore({ path });

        resetInstrumentation();
        expect(await store.snapshot()).toEqual(snapshot as never);
        const cold = observedInstrumentation();
        expect(cold).toEqual({
          directoryReads: 1,
          entryStats: count,
          payloadReads: count,
          payloadBytes: fixture.bytes,
          payloadParses: count,
          entryHashes: count,
          tipHashes: 1,
          fixedReads: 0,
        });

        resetInstrumentation();
        expect(await store.snapshot()).toEqual(snapshot as never);
        const warm = observedInstrumentation();
        expect(warm).toEqual({
          directoryReads: 1,
          entryStats: count,
          payloadReads: 0,
          payloadBytes: 0,
          payloadParses: 0,
          entryHashes: 0,
          tipHashes: 1,
          fixedReads: 2,
        });

        resetInstrumentation();
        await preparePanel(serviceFor(store), `T8${count}`, `append-${count}`);
        const append = observedInstrumentation();
        expect(append.directoryReads).toBe(1);
        expect(append.entryStats).toBe(count + 1);
        expect(append.payloadReads).toBe(0);
        expect(append.payloadBytes).toBe(0);
        expect(append.payloadParses).toBe(0);
        expect(append.entryHashes).toBe(1);
        expect(append.tipHashes).toBe(2);
        expect(append.fixedReads).toBe(2);

        const peer = createFsImplementationEvidenceStore({ path });
        await preparePanel(serviceFor(peer), `T7${count}0`, `peer-${count}-0`);
        await preparePanel(serviceFor(peer), `T7${count}1`, `peer-${count}-1`);
        resetInstrumentation();
        const peerSnapshot = await store.snapshot();
        const suffix = observedInstrumentation();
        expect(peerSnapshot.panels[`cq-implementation-review-panel:v1:${"0".repeat(64)}`]).toBeUndefined();
        expect(suffix.directoryReads).toBe(1);
        expect(suffix.entryStats).toBe(count + 3);
        expect(suffix.payloadReads).toBe(2);
        expect(suffix.payloadParses).toBe(2);
        expect(suffix.entryHashes).toBe(2);
        expect(suffix.tipHashes).toBe(1);
        expect(suffix.fixedReads).toBe(2);

        results.push({ count, cold, warm, append, suffix });
      }
      console.log(`JOURNAL_SCALING ${JSON.stringify(results)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrating and one-entry stale-tip states recover, while active invalid authority fails closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-evidence-migration-"));
    try {
      const snapshot = await frozenSnapshot(root);
      const migrating = join(root, "migrating");
      await writeAuthenticatedChain(migrating, snapshot, 2);
      await writeFile(join(migrating, ".format"), `${JSON.stringify({
        kind: "cq-implementation-evidence-journal-format", version: 1, state: "migrating",
      })}\n`, "utf8");
      await writeFile(join(migrating, ".tip"), "partial", "utf8");
      await expect(createFsImplementationEvidenceStore({ path: migrating }).snapshot())
        .resolves.toEqual(snapshot as never);
      expect(originalJsonParse(await originalReadFile(join(migrating, ".format"), "utf8") as string))
        .toMatchObject({ state: "active" });

      const stale = join(root, "stale");
      const staleStore = await activeJournal(stale, snapshot, 2);
      const prior = originalJsonParse(await originalReadFile(join(stale, ".tip"), "utf8") as string) as {
        sequence: number; digest: string;
      };
      const suffix = await appendAuthenticatedEntry(stale, snapshot, prior.sequence + 1, prior.digest);
      await expect(createFsImplementationEvidenceStore({ path: stale }).snapshot())
        .resolves.toEqual(snapshot as never);
      expect(originalJsonParse(await originalReadFile(join(stale, ".tip"), "utf8") as string))
        .toMatchObject({ sequence: 3, digest: suffix.digest });
      await expect(staleStore.snapshot()).resolves.toEqual(snapshot as never);

      for (const control of ["missing", "malformed", "ahead", "forked"] as const) {
        const path = join(root, `active-${control}`);
        const chain = await writeAuthenticatedChain(path, snapshot, 2);
        await createFsImplementationEvidenceStore({ path }).snapshot();
        if (control === "missing") await rm(join(path, ".tip"));
        if (control === "malformed") await writeFile(join(path, ".tip"), "{}\n", "utf8");
        if (control === "ahead") {
          await writeFile(join(path, ".tip"), `${JSON.stringify(storedTip(3, "a".repeat(64)))}\n`, "utf8");
        }
        if (control === "forked") {
          await writeFile(join(path, ".tip"), `${JSON.stringify(storedTip(2, "b".repeat(64)))}\n`, "utf8");
        }
        expect(chain.digest).not.toBeNull();
        await expect(createFsImplementationEvidenceStore({ path }).snapshot()).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a warm active cache rejects simultaneous format and tip loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-evidence-warm-authority-"));
    try {
      const snapshot = await frozenSnapshot(root);
      const path = join(root, "active");
      const store = await activeJournal(path, snapshot, 2);
      await rm(join(path, ".format"));
      await rm(join(path, ".tip"));

      await expect(store.snapshot()).rejects.toThrow(
        "active implementation evidence journal format and tip disappeared behind the verified cache",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a warm active cache rejects a marker downgrade to migrating", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-evidence-warm-downgrade-"));
    try {
      const snapshot = await frozenSnapshot(root);
      const path = join(root, "active");
      const store = await activeJournal(path, snapshot, 2);
      await writeFile(join(path, ".format"), `${JSON.stringify({
        kind: "cq-implementation-evidence-journal-format",
        version: 1,
        state: "migrating",
      })}\n`, "utf8");

      await expect(store.snapshot()).rejects.toThrow(
        "active implementation evidence journal format moved to migrating behind the verified cache",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("legacy migration recovers from every durable publication crash cut", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-evidence-migration-cuts-"));
    const boundaries = [
      "after-temp-file-sync",
      "after-rename",
      "after-directory-sync",
    ] as const satisfies readonly ImplementationEvidenceJournalFaultBoundary[];
    const publications = [
      "format-migrating",
      "tip",
      "format-active",
    ] as const satisfies readonly ImplementationEvidenceJournalPublication[];
    try {
      const snapshot = await frozenSnapshot(root);
      for (const publication of publications) {
        for (const boundary of boundaries) {
          const path = join(root, `${publication}-${boundary}`);
          await writeAuthenticatedChain(path, snapshot, 2);
          const crashing = createFsImplementationEvidenceStore({
            path,
            faultInjector: (observedBoundary, context) => {
              if (observedBoundary === boundary && context.publication === publication) {
                throw new Error(`injected ${publication} ${boundary}`);
              }
            },
          });
          await expect(crashing.snapshot()).rejects.toThrow(
            `injected ${publication} ${boundary}`,
          );

          const recovered = createFsImplementationEvidenceStore({ path });
          await expect(recovered.snapshot()).resolves.toEqual(snapshot as never);
          expect(originalJsonParse(
            await originalReadFile(join(path, ".format"), "utf8") as string,
          )).toMatchObject({ state: "active" });
          expect(originalJsonParse(
            await originalReadFile(join(path, ".tip"), "utf8") as string,
          )).toMatchObject({ sequence: 2 });
          expect((await readdir(path)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("append recovery reflects every entry and tip publication crash cut", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-evidence-append-cuts-"));
    const boundaries = [
      "after-temp-file-sync",
      "after-rename",
      "after-directory-sync",
    ] as const satisfies readonly ImplementationEvidenceJournalFaultBoundary[];
    const publications = [
      "entry",
      "tip",
    ] as const satisfies readonly ImplementationEvidenceJournalPublication[];
    try {
      const snapshot = await frozenSnapshot(root);
      const initialPanelCount = Object.keys(
        snapshot["panels"] as Record<string, unknown>,
      ).length;
      let caseNumber = 0;
      for (const publication of publications) {
        for (const boundary of boundaries) {
          const path = join(root, `${publication}-${boundary}`);
          await activeJournal(path, snapshot, 1);
          const crashing = createFsImplementationEvidenceStore({
            path,
            faultInjector: (observedBoundary, context) => {
              if (observedBoundary === boundary && context.publication === publication) {
                throw new Error(`injected ${publication} ${boundary}`);
              }
            },
          });
          await crashing.snapshot();
          caseNumber += 1;
          await expect(preparePanel(
            serviceFor(crashing),
            `T9${caseNumber}`,
            `append-${publication}-${boundary}`,
          )).rejects.toThrow(`injected ${publication} ${boundary}`);

          const recovered = createFsImplementationEvidenceStore({ path });
          const recoveredSnapshot = await recovered.snapshot();
          const entryWasPublished = publication !== "entry" || boundary !== "after-temp-file-sync";
          expect(Object.keys(recoveredSnapshot.panels).length).toBe(
            initialPanelCount + (entryWasPublished ? 1 : 0),
          );
          expect(originalJsonParse(
            await originalReadFile(join(path, ".tip"), "utf8") as string,
          )).toMatchObject({ sequence: entryWasPublished ? 2 : 1 });
          expect((await readdir(path)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("warm reconciliation rejects retained identity changes, loss, renames, forks, and unexpected files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-evidence-integrity-"));
    try {
      const snapshot = await frozenSnapshot(root);
      for (const control of ["truncate", "missing", "rename", "fork", "unexpected"] as const) {
        const path = join(root, control);
        const store = await activeJournal(path, snapshot, 3);
        const entries = (await readdir(path)).filter((name) => name.endsWith(".json")).sort();
        const middle = entries[1]!;
        if (control === "truncate") await writeFile(join(path, middle), "{}\n", "utf8");
        if (control === "missing") await rm(join(path, middle));
        if (control === "rename") await fs.rename(join(path, middle), join(path, `0000000000000002-${"c".repeat(64)}.json`));
        if (control === "fork") await writeFile(join(path, `0000000000000004-${"d".repeat(64)}.json`), "{}\n", "utf8");
        if (control === "unexpected") await writeFile(join(path, "authority.json.bak"), "{}\n", "utf8");
        await expect(store.snapshot()).rejects.toThrow();
      }

      const temporaryPath = join(root, "temporary");
      const store = await activeJournal(temporaryPath, snapshot, 1);
      const temporary = join(temporaryPath, ".tmp-entry-123-controlled");
      await writeFile(temporary, "partial", "utf8");
      await expect(store.snapshot()).resolves.toEqual(snapshot as never);
      await expect(fs.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("implementation evidence generic-mutation authority", () => {
  test("only the exact frozen owner-bound non-task descriptor bypasses evidence snapshotting", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-evidence-guard-"));
    const rawStore = new InMemoryLedgerStore();
    await rawStore.init();
    try {
      const snapshot = await frozenSnapshot(root);
      const memoryEvidence = createInMemoryImplementationEvidenceStore(snapshot as never);
      let snapshotCalls = 0;
      const countedEvidence = {
        async snapshot() {
          snapshotCalls += 1;
          return await memoryEvidence.snapshot();
        },
      };
      const milestone = await rawStore.createMilestone({ title: "guard controls" });
      await rawStore.createItem(QUESTIONS_LEDGER, milestone.id, {
        id: "Q1", status: "open", fields: { question: "Proceed?", context: "test", answer: "draft" },
      });
      await rawStore.createItem(TASKS_LEDGER, milestone.id, {
        id: "T2345", status: "wip", fields: { headline: "activated task" },
      });
      const protectedStore = protectLedgerStoreWithImplementationEvidence(
        rawStore,
        countedEvidence as never,
      );
      const atomic = protectedStore as never as {
        runAtomicGenericMutation(
          mutate: (tx: { updateItem(ledgerId: string, itemId: string, patch: object): unknown }) => unknown,
          readRoots: () => Promise<{ roots: readonly string[]; epoch: number }>,
          measurement: undefined,
          scope: object | undefined,
          context?: object,
          binding?: object,
        ): Promise<unknown>;
      };
      const worksetStore = createInMemoryWorksetStore();
      let authenticContext: object | undefined;
      let authenticBinding: object | undefined;
      const gateway = createWorksetGenericMutationGateway({
        rawStore: protectedStore,
        worksetStore,
        runGenericTransaction: async (mutate, measurement, scope, context, binding) => {
          authenticContext = context;
          authenticBinding = binding;
          return await atomic.runAtomicGenericMutation(
            mutate as never,
            async () => await worksetStore.snapshot(),
            measurement as undefined,
            scope,
            context,
            binding,
          ) as never;
        },
      });

      snapshotCalls = 0;
      await gateway.updateItem(QUESTIONS_LEDGER, "Q1", { fields: { answer: "yes" } });
      expect(snapshotCalls).toBe(0);
      expect(rawStore.fetchItem(QUESTIONS_LEDGER, "Q1").fields.answer).toBe("yes");
      expect(authenticContext).toBeDefined();
      expect(authenticBinding).toBeDefined();

      snapshotCalls = 0;
      await expect(gateway.updateItem(TASKS_LEDGER, "T2345", { status: "done" }))
        .rejects.toThrow("protected implementation evidence");
      expect(snapshotCalls).toBe(1);

      const context = authenticContext as Record<string, unknown>;
      const binding = authenticBinding as object;
      const scope = context["scope"] as Record<string, unknown>;
      const controls: Array<{ name: string; scope?: object; context?: object; binding?: object }> = [
        { name: "absent" },
        { name: "structural-lookalike", scope, context: { ...context }, binding },
        { name: "forged-frozen", scope, context: Object.freeze({ ...context }), binding },
        { name: "mutable", scope, context: { ...context, scope: { ...scope } }, binding },
        { name: "ambiguous", scope, context: Object.freeze({ ...context, scope: Object.freeze({ ...scope, referenceCandidates: Object.freeze(["T2345"]) }) }), binding },
        { name: "scope-mismatch", scope: Object.freeze({ ...scope }), context, binding },
        { name: "prototype-binding", scope, context, binding: Object.create(Object.getPrototypeOf(binding)) as object },
      ];
      for (const control of controls) {
        snapshotCalls = 0;
        await expect(atomic.runAtomicGenericMutation(
          (tx) => tx.updateItem(TASKS_LEDGER, "T2345", { status: "abandoned" }),
          async () => await worksetStore.snapshot(),
          undefined,
          control.scope,
          control.context,
          control.binding,
        ), control.name).rejects.toThrow("protected implementation evidence");
        expect(snapshotCalls, control.name).toBe(1);
      }

      let foreignBinding: object | undefined;
      const foreignGateway = createWorksetGenericMutationGateway({
        rawStore: protectedStore,
        worksetStore,
        runGenericTransaction: async (mutate, measurement, foreignScope, foreignContext, bindingValue) => {
          foreignBinding = bindingValue;
          return await atomic.runAtomicGenericMutation(mutate as never, async () => await worksetStore.snapshot(),
            measurement as undefined, foreignScope, foreignContext, bindingValue) as never;
        },
      });
      await foreignGateway.updateItem(QUESTIONS_LEDGER, "Q1", { fields: { answer: "still yes" } });
      snapshotCalls = 0;
      await expect(atomic.runAtomicGenericMutation(
        (tx) => tx.updateItem(TASKS_LEDGER, "T2345", { status: "done" }),
        async () => await worksetStore.snapshot(),
        undefined,
        scope,
        context,
        foreignBinding,
      )).rejects.toThrow("protected implementation evidence");
      expect(snapshotCalls).toBe(1);
      expect(rawStore.fetchItem(TASKS_LEDGER, "T2345").status).toBe("wip");
    } finally {
      await rawStore.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
