/**
 * A single-shot peer PROCESS that prepares one dispatch (T720, goal G94).
 *
 * Spawned N-up by `attestationStore-crossProcess.test.ts` so that concurrent
 * reuse of ONE idempotency key is decided by the backend's REAL cross-process
 * lock — `BEGIN IMMEDIATE` on a WAL connection — and
 * not by an in-process mutex, which is all a same-process race can exercise.
 * This is T685's deferred `cross-process-concurrent-key-reuse-under-a-real-lock`.
 *
 * Usage: bun <this> <dbPath> <projectKey> <idempotencyKey>
 * Prints ONE line of JSON on stdout: {"ok":true,"attestationId":…} or
 * {"ok":false,"error":…}.
 */

import {
  DISPATCH_OVERLAY_REGISTRY,
  SqliteAttestationBackend,
  defaultDispatchRandomBytes,
  prepareDispatchOn,
  type AttestationBackend,
  type PrepareDispatchRequest,
} from "@cq/config";

const [location, projectKey, idempotencyKey] = process.argv.slice(2);
if (
  location === undefined ||
  projectKey === undefined ||
  idempotencyKey === undefined
) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: "usage" })}\n`);
  process.exit(2);
}

const request: PrepareDispatchRequest = {
  namespace: { backend: "xdg", projectKey },
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
    round: 0,
    startingCommit: "8a8f94424a3eda1c2cb3aa1b0ccd47d5eca4ea2e",
    validationIntent: "final",
  },
  idempotencyKey,
  timeoutMs: 600_000,
  registry: DISPATCH_OVERLAY_REGISTRY,
  promptDigest: "a".repeat(64),
  catalogHash: "b".repeat(64),
  expectedChild: { childId: "child-t720", runId: `run-${String(process.pid)}` },
};

// OPEN inside the try as well: a constructor failure is an outcome the parent
// must be able to read, not a silent crash. When it was outside, a peer that lost
// the WAL-conversion race exited having printed nothing at all, and the parent
// could only report "peer produced no JSON" — which hid the actual defect
// (a missing busy_timeout during WAL conversion) behind a test-harness message.
let backend: AttestationBackend | undefined;
try {
  backend = new SqliteAttestationBackend({
    namespace: { backend: "xdg", projectKey },
    dbPath: location,
  });
  const outcome = await prepareDispatchOn(backend, request, {
    mode: "backend",
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
  await backend?.close();
}
