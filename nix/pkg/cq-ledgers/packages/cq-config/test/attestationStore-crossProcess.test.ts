/**
 * Cross-PROCESS concurrent key reuse under each backend's REAL lock
 * (T720, goal G94 — T685's deferred
 * `cross-process-concurrent-key-reuse-under-a-real-lock`).
 *
 * The shared adapter contract races two units of work on ONE handle, which the
 * in-process {@link AsyncMutex} decides. That proves nothing about the durable
 * lock: two `await`-interleaved calls on one handle are the same process and the
 * same lock holder. So this suite spawns real peer PROCESSES, all preparing with
 * the SAME idempotency key against ONE location at the same time, and asserts
 * that exactly one row lands — decided by `BEGIN IMMEDIATE` on a WAL connection
 * or by an `O_EXCL` lockfile, with no in-process coordination available at all.
 *
 * The `remote` and `git-object` backends have no adapter precisely because they
 * cannot offer this ({@link ATTESTATION_EXCLUDED_BACKENDS}); the assertion here
 * is what that exclusion is measured against.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ATTESTATION_DB_FILENAME,
  FsAttestationBackend,
  SqliteAttestationBackend,
  type AttestationBackend,
  type AttestationRow,
} from "@cq/config";

const WORKER = join(dirname(import.meta.path), "fixtures", "attestationKeyReuseWorker.ts");
const PEERS = 4;
const IDEMPOTENCY_KEY = "cross-process-round-0";

const roots: string[] = [];

function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface WorkerOutcome {
  readonly ok: boolean;
  readonly attestationId?: string;
  readonly error?: string;
}

async function racePeers(
  kind: "sqlite" | "fs",
  location: string,
): Promise<readonly WorkerOutcome[]> {
  const children = Array.from({ length: PEERS }, () =>
    Bun.spawn(["bun", WORKER, kind, location, "raced-project", IDEMPOTENCY_KEY], {
      cwd: dirname(dirname(dirname(dirname(WORKER)))),
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  return Promise.all(
    children.map(async (child) => {
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        return JSON.parse(line) as WorkerOutcome;
      } catch {
        throw new Error(`peer produced no JSON: stdout=${stdout} stderr=${stderr}`);
      }
    }),
  );
}

function assertExactlyOneWinner(
  outcomes: readonly WorkerOutcome[],
  rows: readonly AttestationRow[],
): void {
  const all = JSON.stringify(outcomes);
  const winners = outcomes.filter((outcome) => outcome.ok);
  const losers = outcomes.filter((outcome) => !outcome.ok);

  // THE invariant, and what a broken lock violates: one winner, one durable row.
  // Mutating `BEGIN IMMEDIATE` to `BEGIN DEFERRED` or removing the fs lockfile
  // both produce two winners or a lost update, and both are caught here.
  expect(winners, all).toHaveLength(1);
  expect(losers, all).toHaveLength(PEERS - 1);
  expect(rows, all).toHaveLength(1);
  expect(rows[0]?.idempotencyKey).toBe(IDEMPOTENCY_KEY);
  expect(rows[0]?.attestationId).toBe(winners[0]?.attestationId);

  // Each loser must lose for a LEGITIMATE reason. Losing because the key is held
  // is the expected path. Losing because the store stayed locked past its bounded
  // wait is ALSO correct store behaviour — under enough CPU contention a peer can
  // genuinely exhaust the busy timeout — so it is accepted, but only explicitly:
  // anything else (a corrupt read, an unclassified driver error, a crash with no
  // output) means the lock is not serializing them and must fail.
  const keyHeld = losers.filter((loser) =>
    /AttestationKeyReuseError|idempotency key/.test(loser.error ?? ""),
  );
  const lockedOut = losers.filter((loser) =>
    /AttestationTransportError|is locked|database is locked|SQLITE_BUSY/.test(loser.error ?? ""),
  );
  expect(keyHeld.length + lockedOut.length, `unexplained loser reason in ${all}`).toBe(
    losers.length,
  );
  // Contention is the exception, not the rule: at least one peer must have been
  // refused by the KEY, or the test would pass without ever exercising the
  // idempotency guard it exists to check.
  expect(
    keyHeld.length,
    `every peer merely timed out, so the key guard was never reached: ${all}`,
  ).toBeGreaterThanOrEqual(1);
}

async function withBackend(
  backend: AttestationBackend & { storedRows(): readonly AttestationRow[] },
  run: () => Promise<readonly WorkerOutcome[]>,
): Promise<void> {
  try {
    assertExactlyOneWinner(await run(), backend.storedRows());
  } finally {
    await backend.close();
  }
}

describe(`${PEERS} peer processes reusing one idempotency key`, () => {
  test("bun:sqlite serializes them with BEGIN IMMEDIATE: exactly one row lands", async () => {
    const dbPath = join(freshRoot("cq-t720-xproc-sqlite-"), ATTESTATION_DB_FILENAME);
    const outcomes = await racePeers("sqlite", dbPath);
    // The observer opens AFTER the race, so it cannot have participated in it.
    const observer = new SqliteAttestationBackend({
      namespace: { backend: "xdg", projectKey: "raced-project" },
      dbPath,
    });
    await withBackend(observer, () => Promise.resolve(outcomes));
  }, 60_000);

  test("the filesystem store serializes them with an O_EXCL lockfile: exactly one row lands", async () => {
    const root = freshRoot("cq-t720-xproc-fs-");
    const outcomes = await racePeers("fs", root);
    const observer = new FsAttestationBackend({
      namespace: { backend: "fs", projectKey: "raced-project" },
      root,
    });
    await withBackend(observer, () => Promise.resolve(outcomes));
  }, 60_000);
});
