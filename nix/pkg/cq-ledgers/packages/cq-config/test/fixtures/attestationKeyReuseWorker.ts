/**
 * A single-shot peer PROCESS that prepares one dispatch (T720, goal G94).
 *
 * Spawned N-up by `attestationStore-crossProcess.test.ts` so that concurrent
 * reuse of ONE idempotency key is decided by the backend's REAL cross-process
 * lock — `BEGIN IMMEDIATE` on a WAL connection, or an `O_EXCL` lockfile — and
 * not by an in-process mutex, which is all a same-process race can exercise.
 * This is T685's deferred `cross-process-concurrent-key-reuse-under-a-real-lock`.
 *
 * Usage: bun <this> <sqlite|fs> <location> <projectKey> <idempotencyKey>
 * Prints ONE line of JSON on stdout: {"ok":true,"attestationId":…} or
 * {"ok":false,"error":…}.
 */

import {
  DISPATCH_OVERLAY_REGISTRY,
  FsAttestationBackend,
  SqliteAttestationBackend,
  defaultDispatchRandomBytes,
  prepareDispatchOn,
  type AttestationBackend,
  type AttestationNamespace,
  type PrepareDispatchRequest,
} from "@cq/config";

const [kind, location, projectKey, idempotencyKey] = process.argv.slice(2);
if (
  kind === undefined ||
  location === undefined ||
  projectKey === undefined ||
  idempotencyKey === undefined
) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: "usage" })}\n`);
  process.exit(2);
}

function openBackend(): AttestationBackend {
  if (kind === "sqlite") {
    const namespace: AttestationNamespace = { backend: "xdg", projectKey: projectKey! };
    return new SqliteAttestationBackend({ namespace, dbPath: location! });
  }
  if (kind === "fs") {
    const namespace: AttestationNamespace = { backend: "fs", projectKey: projectKey! };
    return new FsAttestationBackend({ namespace, root: location!, lockTimeoutMs: 20_000 });
  }
  throw new Error(`unknown backend kind "${String(kind)}"`);
}

const request: PrepareDispatchRequest = {
  namespace: { backend: kind === "sqlite" ? "xdg" : "fs", projectKey: projectKey! },
  roleId: "implement-worker",
  surface: "claude",
  input: {
    taskId: "T720",
    headline: "cross-process key reuse",
    description: "One idempotency key, several processes.",
    acceptance: "Exactly one process wins.",
    worktreePath: "/tmp/wt-T720",
    branch: "implement/T720",
    baseCommit: "8a8f94424a3eda1c2cb3aa1b0ccd47d5eca4ea2e",
  },
  idempotencyKey: idempotencyKey!,
  timeoutMs: 600_000,
  registry: DISPATCH_OVERLAY_REGISTRY,
  promptDigest: "a".repeat(64),
  catalogHash: "b".repeat(64),
  expectedChild: { childId: "child-t720", runId: `run-${String(process.pid)}` },
};

const backend = openBackend();
try {
  const outcome = await prepareDispatchOn(backend, request, {
    now: () => new Date().toISOString(),
    randomBytes: defaultDispatchRandomBytes,
  });
  process.stdout.write(
    `${JSON.stringify(
      outcome.accepted
        ? { ok: true, attestationId: outcome.prepared.attestationId }
        : { ok: false, error: `${outcome.reason}: ${outcome.detail}` },
    )}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })}\n`,
  );
} finally {
  await backend.close();
}
