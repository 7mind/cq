/**
 * T1568 regression: the public SQLite initializer must install busy_timeout
 * before its first WAL request and retry that request after SQLITE_BUSY. This
 * uses real Bun subprocesses because SQLite lock ownership and the synchronous
 * public initializer cannot be represented by an in-process dummy.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enableWalWithRetry,
  WAL_CONVERSION_ATTEMPTS,
  WAL_RETRY_SLEEP_MS,
} from "../src/store/sqlite/connection.js";
import {
  CHILD_DEADLINE_MS,
  CHILD_KILL_GRACE_MS,
  CONFIGURED_WAIT_BUDGET_MS,
  CONTENDER_COUNT,
  LEGACY_WAL_CALL_SITE,
  PUBLIC_INITIALIZER_CEILING_MS,
  PUBLIC_WAL_CALL_SITE,
  SCHEDULING_HEADROOM_MS,
  TEST_DEADLINE_MS,
  WAL_PRAGMA,
  type ChildEvent,
  type ParentEvent,
  type TranscriptEntry,
} from "./sqliteConnectionContentionProtocol.js";

const OWNER_FIXTURE = fileURLToPath(
  new URL("./sqliteConnectionContentionOwner.ts", import.meta.url),
);
const CONTENDER_FIXTURE = fileURLToPath(
  new URL("./sqliteConnectionContentionContender.ts", import.meta.url),
);

interface FixtureResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly elapsedMs: number;
  readonly deadlineReport: string | undefined;
}

type FixtureProcess = ReturnType<typeof spawnFixture>;

function formatTranscript(transcript: readonly TranscriptEntry[]): string {
  return transcript
    .map(({ sequence, event }) => `${String(sequence).padStart(2, "0")} ${JSON.stringify(event)}`)
    .join("\n");
}

function captureStderr(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let captured = "";
  const completed = (async (): Promise<void> => {
    const reader = stream.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      captured += decoder.decode(chunk.value, { stream: true });
    }
    captured += decoder.decode();
  })();
  return { completed, snapshot: (): string => captured };
}

function captureEvents(
  stream: ReadableStream<Uint8Array>,
  record: (event: ChildEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  return (async (): Promise<void> => {
    const reader = stream.getReader();
    let pending = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach((line) => {
        if (line !== "") record(JSON.parse(line) as ChildEvent);
      });
    }
    pending += decoder.decode();
    if (pending !== "") record(JSON.parse(pending) as ChildEvent);
  })();
}

function spawnFixture(
  childName: string,
  fixture: string,
  args: readonly string[],
  record: (event: ChildEvent) => void,
  scenarioStartedAt: number,
  transcript: readonly TranscriptEntry[],
) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", fixture, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = captureStderr(proc.stderr);
  const eventsCompleted = captureEvents(proc.stdout, record);
  let deadlineReport: string | undefined;
  const watchdog = (async (): Promise<void> => {
    const remainingMs = Math.max(0, scenarioStartedAt + CHILD_DEADLINE_MS - Date.now());
    const reachedDeadline = await Promise.race([
      proc.exited.then(() => false),
      Bun.sleep(remainingMs).then(() => true),
    ]);
    if (!reachedDeadline) return;

    deadlineReport =
      `${childName} reached the ${String(CHILD_DEADLINE_MS)}ms hard child deadline\n` +
      `protocol state:\n${formatTranscript(transcript)}\n` +
      `stderr:\n${stderr.snapshot() || "<empty>"}`;
    proc.kill("SIGTERM");
    const exitedDuringGrace = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(CHILD_KILL_GRACE_MS).then(() => false),
    ]);
    if (!exitedDuringGrace) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  })();
  return {
    childName,
    proc,
    scenarioStartedAt,
    stderr,
    eventsCompleted,
    watchdog,
    get deadlineReport(): string | undefined {
      return deadlineReport;
    },
    reapPromise: undefined as Promise<FixtureResult> | undefined,
  };
}

async function waitFor(
  predicate: () => boolean,
  deadlineAt: number,
  description: string,
  transcript: readonly TranscriptEntry[],
  children: readonly FixtureProcess[],
): Promise<void> {
  while (!predicate()) {
    const deadlineFailure = children.find((child) => child.deadlineReport !== undefined);
    if (deadlineFailure !== undefined) throw new Error(deadlineFailure.deadlineReport);
    if (Date.now() >= deadlineAt) {
      await Promise.all(children.map((child) => child.watchdog));
      const reports = children
        .map((child) => child.deadlineReport)
        .filter((report): report is string => report !== undefined);
      throw new Error(
        reports.join("\n\n") ||
          `timed out waiting for ${description}\n` +
            `protocol state:\n${formatTranscript(transcript)}\n` +
            `stderr:\n${children
              .map((child) => `${child.childName}: ${child.stderr.snapshot() || "<empty>"}`)
              .join("\n")}`,
      );
    }
    await Bun.sleep(Math.min(10, deadlineAt - Date.now()));
  }
}

async function reap(
  child: FixtureProcess,
  record: (event: ParentEvent) => void,
): Promise<FixtureResult> {
  child.reapPromise ??= (async (): Promise<FixtureResult> => {
    const exitCode = await child.proc.exited;
    await child.watchdog;
    await child.eventsCompleted;
    await child.stderr.completed;
    const elapsedMs = Date.now() - child.scenarioStartedAt;
    const result = {
      exitCode,
      stderr: child.stderr.snapshot(),
      elapsedMs,
      deadlineReport: child.deadlineReport,
    };
    record({
      type: "child-reaped",
      childName: child.childName,
      exitCode,
      elapsedMs,
    });
    return result;
  })();
  return child.reapPromise;
}

async function terminateAndReap(
  child: FixtureProcess,
  record: (event: ParentEvent) => void,
): Promise<FixtureResult> {
  if (child.proc.exitCode === null) {
    child.proc.kill("SIGTERM");
    const exitedDuringGrace = await Promise.race([
      child.proc.exited.then(() => true),
      Bun.sleep(CHILD_KILL_GRACE_MS).then(() => false),
    ]);
    if (!exitedDuringGrace) {
      child.proc.kill("SIGKILL");
      await child.proc.exited;
    }
  }
  return reap(child, record);
}

function eventIndex(
  transcript: readonly TranscriptEntry[],
  predicate: (event: ChildEvent | ParentEvent) => boolean,
): number {
  return transcript.findIndex(({ event }) => predicate(event));
}

function sqliteError(message: string, code: string, errno: number): Error {
  return Object.assign(new Error(message), { code, errno });
}

function requireEventualWalSuccess(
  requireInvariant: (condition: boolean, message: string) => void,
  contenderId: string,
  own: readonly (ChildEvent | ParentEvent)[],
): void {
  const attempts = own.filter(
    (event): event is Extract<ChildEvent, { readonly type: "wal-attempt" }> =>
      event.type === "wal-attempt",
  );
  const successful = own.find(
    (event): event is Extract<ChildEvent, { readonly type: "wal-attempt-succeeded" }> =>
      event.type === "wal-attempt-succeeded",
  );
  const initializer = own.find(
    (event): event is Extract<ChildEvent, { readonly type: "initializer-succeeded" }> =>
      event.type === "initializer-succeeded",
  );
  const busyFailures = own.filter(
    (
      event,
    ): event is
      | Extract<ChildEvent, { readonly type: "first-wal-busy-held" }>
      | Extract<ChildEvent, { readonly type: "fixture-second-wal-busy-injected" }> =>
      event.type === "first-wal-busy-held" || event.type === "fixture-second-wal-busy-injected",
  );

  requireInvariant(
    successful !== undefined && successful.attempt >= 2,
    `${contenderId} must have a successful WAL attempt at or after retry 2`,
  );
  if (successful === undefined) return;

  requireInvariant(
    initializer !== undefined && initializer.walAttempts === successful.attempt,
    `${contenderId} initializer-success WAL count must equal the first successful WAL attempt`,
  );
  requireInvariant(
    successful.attempt <= WAL_CONVERSION_ATTEMPTS,
    `${contenderId} successful WAL attempt must stay within the retry ceiling`,
  );
  requireInvariant(
    attempts.length === successful.attempt,
    `${contenderId} WAL attempt transcript must end at its first successful attempt`,
  );
  attempts.forEach((attempt, index) => {
    requireInvariant(
      attempt.attempt === index + 1 && attempt.sql === WAL_PRAGMA,
      `${contenderId} must report every exact WAL attempt in sequence`,
    );
  });
  requireInvariant(
    busyFailures.length === successful.attempt - 1 &&
      busyFailures.every(
        (failure, index) =>
          failure.attempt === index + 1 &&
          failure.primaryErrno === 5 &&
          (failure.code === "SQLITE_BUSY" || failure.code === "SQLITE_BUSY_RECOVERY") &&
          failure.callSite === PUBLIC_WAL_CALL_SITE,
      ),
    `${contenderId} must have contiguous busy-only failures before successful WAL`,
  );
}

const FORMER_EXACT_SECOND_VIOLATION = "former exact-attempt-2 predicate violation";

function formerExactSecondSuccessPredicate(
  own: readonly (ChildEvent | ParentEvent)[],
): string | undefined {
  const succeededAtAttemptTwo = own.find(
    (event) => event.type === "wal-attempt-succeeded" && event.attempt === 2,
  );
  const initializer = own.find((event) => event.type === "initializer-succeeded");
  return succeededAtAttemptTwo !== undefined &&
    initializer !== undefined &&
    initializer.walAttempts === 2
    ? undefined
    : FORMER_EXACT_SECOND_VIOLATION;
}

function observeInjectedWalPolicy(errors: readonly Error[]): {
  readonly attempts: number;
  readonly sleeps: readonly number[];
  readonly thrown: unknown;
} {
  let attempts = 0;
  let nextError = 0;
  const sleeps: number[] = [];
  let thrown: unknown;
  try {
    enableWalWithRetry(
      () => {
        attempts += 1;
        if (nextError < errors.length) {
          const error = errors[nextError];
          nextError += 1;
          throw error;
        }
      },
      (delayMs) => sleeps.push(delayMs),
    );
  } catch (error) {
    thrown = error;
  }
  return { attempts, sleeps, thrown };
}

describe("mandatory WAL retry policy", () => {
  test(
    "SQLITE_BUSY_RECOVERY succeeds on attempt 3 after two requested delays",
    () => {
      const observation = observeInjectedWalPolicy([
        sqliteError("recovering-1", "SQLITE_BUSY_RECOVERY", 261),
        sqliteError("recovering-2", "SQLITE_BUSY_RECOVERY", 261),
      ]);
      expect(observation.thrown).toBeUndefined();
      expect(observation.attempts).toBe(3);
      expect(observation.sleeps).toEqual([WAL_RETRY_SLEEP_MS, WAL_RETRY_SLEEP_MS]);
      expect(WAL_RETRY_SLEEP_MS).toBe(25);
    },
    TEST_DEADLINE_MS,
  );

  test(
    "the fifth busy result is rethrown after five attempts and four delays",
    () => {
      const errors = Array.from({ length: WAL_CONVERSION_ATTEMPTS }, (_, index) =>
        sqliteError(`busy-${String(index + 1)}`, "SQLITE_BUSY", 5),
      );
      const observation = observeInjectedWalPolicy(errors);
      expect(WAL_CONVERSION_ATTEMPTS).toBe(5);
      expect(observation.thrown).toBe(errors[errors.length - 1]);
      expect(observation.attempts).toBe(WAL_CONVERSION_ATTEMPTS);
      expect(observation.sleeps).toEqual(
        Array.from({ length: WAL_CONVERSION_ATTEMPTS - 1 }, () => WAL_RETRY_SLEEP_MS),
      );
    },
    TEST_DEADLINE_MS,
  );

  test(
    "a non-busy result propagates after one attempt and no delay",
    () => {
      const error = sqliteError("constraint", "SQLITE_CONSTRAINT", 19);
      const observation = observeInjectedWalPolicy([error]);
      expect(observation.thrown).toBe(error);
      expect(observation.attempts).toBe(1);
      expect(observation.sleeps).toEqual([]);
    },
    TEST_DEADLINE_MS,
  );

  test(
    "a malformed-database result propagates after one attempt and no delay",
    () => {
      const error = sqliteError("database disk image is malformed", "SQLITE_NOTADB", 26);
      const observation = observeInjectedWalPolicy([error]);
      expect(observation.thrown).toBe(error);
      expect(observation.attempts).toBe(1);
      expect(observation.sleeps).toEqual([]);
    },
    TEST_DEADLINE_MS,
  );
});

test("eventual WAL success guard accepts attempt 3 and rejects the former exact-second predicate", () => {
  const contenderId = "guard-contender";
  const own: ChildEvent[] = [
    {
      type: "wal-attempt",
      contenderId,
      attempt: 1,
      sql: WAL_PRAGMA,
      busyTimeoutInstalled: true,
    },
    {
      type: "first-wal-busy-held",
      contenderId,
      attempt: 1,
      callSite: PUBLIC_WAL_CALL_SITE,
      busyTimeoutInstalled: true,
      code: "SQLITE_BUSY",
      errno: 5,
      primaryErrno: 5,
    },
    {
      type: "wal-attempt",
      contenderId,
      attempt: 2,
      sql: WAL_PRAGMA,
      busyTimeoutInstalled: true,
    },
    {
      type: "fixture-second-wal-busy-injected",
      contenderId,
      attempt: 2,
      callSite: PUBLIC_WAL_CALL_SITE,
      code: "SQLITE_BUSY",
      errno: 5,
      primaryErrno: 5,
    },
    {
      type: "wal-attempt",
      contenderId,
      attempt: 3,
      sql: WAL_PRAGMA,
      busyTimeoutInstalled: true,
    },
    {
      type: "wal-attempt-succeeded",
      contenderId,
      attempt: 3,
      sql: WAL_PRAGMA,
      execution: "real",
    },
    {
      type: "initializer-succeeded",
      contenderId,
      elapsedMs: 0,
      walAttempts: 3,
    },
  ];
  const violations: string[] = [];
  requireEventualWalSuccess(
    (condition, message) => {
      if (!condition) violations.push(message);
    },
    contenderId,
    own,
  );

  expect(violations).toEqual([]);
  expect(formerExactSecondSuccessPredicate(own)).toBe(FORMER_EXACT_SECOND_VIOLATION);
});

test(
  "T1568 public initializer installs timeout before WAL and retries the held first busy error",
  async () => {
    const scenarioStartedAt = Date.now();
    const childDeadlineAt = scenarioStartedAt + CHILD_DEADLINE_MS;
    expect(CONFIGURED_WAIT_BUDGET_MS).toBe(25_100);
    expect(CONFIGURED_WAIT_BUDGET_MS).toBeLessThan(PUBLIC_INITIALIZER_CEILING_MS);
    expect(PUBLIC_INITIALIZER_CEILING_MS).toBeLessThan(CHILD_DEADLINE_MS);
    expect(CHILD_DEADLINE_MS).toBeLessThan(TEST_DEADLINE_MS);
    expect(CHILD_DEADLINE_MS + CHILD_KILL_GRACE_MS).toBeLessThan(TEST_DEADLINE_MS);
    expect(PUBLIC_INITIALIZER_CEILING_MS - CONFIGURED_WAIT_BUDGET_MS).toBe(SCHEDULING_HEADROOM_MS);

    const root = await mkdtemp(path.join(tmpdir(), "cq-sqlite-contention-"));
    const dbPath = path.join(root, "shared.db");
    const ownerReleasePath = path.join(root, "owner-release.ack");
    const releaseAckPath = path.join(root, "release.ack");
    const peerReleaseAckPath = path.join(root, "peer-release.ack");
    const secondWalReleasePath = path.join(root, "second-wal-release.ack");
    const gatedContenderId = "contender-1";
    const transcript: TranscriptEntry[] = [];
    const children: FixtureProcess[] = [];
    let nextSequence = 1;
    const record = (event: ChildEvent | ParentEvent): void => {
      transcript.push({ sequence: nextSequence, event });
      nextSequence += 1;
    };

    try {
      const owner = spawnFixture(
        "owner",
        OWNER_FIXTURE,
        [dbPath, ownerReleasePath],
        record,
        scenarioStartedAt,
        transcript,
      );
      children.push(owner);
      await waitFor(
        () => eventIndex(transcript, (event) => event.type === "owner-lock-acquired") >= 0,
        childDeadlineAt,
        "owner-lock-acquired",
        transcript,
        children,
      );

      const legacy = spawnFixture(
        "legacy-control",
        CONTENDER_FIXTURE,
        ["legacy", dbPath],
        record,
        scenarioStartedAt,
        transcript,
      );
      children.push(legacy);
      const contenders = Array.from({ length: CONTENDER_COUNT }, (_, index) => {
        const contenderId = `contender-${String(index + 1)}`;
        const child = spawnFixture(
          contenderId,
          CONTENDER_FIXTURE,
          [
            "public",
            dbPath,
            contenderId === gatedContenderId ? releaseAckPath : peerReleaseAckPath,
            contenderId,
            String(scenarioStartedAt),
            ...(contenderId === gatedContenderId ? [secondWalReleasePath] : []),
          ],
          record,
          scenarioStartedAt,
          transcript,
        );
        children.push(child);
        return { contenderId, child };
      });

      await waitFor(
        () => eventIndex(transcript, (event) => event.type === "legacy-control-result") >= 0,
        childDeadlineAt,
        "legacy journal-before-timeout result",
        transcript,
        children,
      );
      await waitFor(
        () =>
          transcript.filter(({ event }) => event.type === "first-wal-busy-held").length ===
          CONTENDER_COUNT,
        childDeadlineAt,
        "every contender to hold its first WAL busy error",
        transcript,
        children,
      );

      record({ type: "release-request" });
      await writeFile(ownerReleasePath, "released\n", { flag: "wx" });
      await waitFor(
        () => eventIndex(transcript, (event) => event.type === "owner-released") >= 0,
        childDeadlineAt,
        "owner-released",
        transcript,
        children,
      );
      await writeFile(releaseAckPath, "released\n", { flag: "wx" });
      record({ type: "release-ack-written" });

      await waitFor(
        () =>
          eventIndex(
            transcript,
            (event) =>
              event.type === "second-wal-execution-held" && event.contenderId === gatedContenderId,
          ) >= 0,
        childDeadlineAt,
        "gated contender to hold before WAL attempt 2",
        transcript,
        children,
      );
      const peerContenderId = contenders.find(
        ({ contenderId }) => contenderId !== gatedContenderId,
      )?.contenderId;
      await writeFile(peerReleaseAckPath, "released\n", { flag: "wx" });
      record({ type: "peer-release-ack-written" });
      await waitFor(
        () =>
          peerContenderId !== undefined &&
          eventIndex(
            transcript,
            (event) =>
              event.type === "wal-attempt-succeeded" &&
              event.contenderId === peerContenderId &&
              event.attempt === 2 &&
              event.execution === "real",
          ) >= 0,
        childDeadlineAt,
        "peer contender to complete real WAL attempt 2",
        transcript,
        children,
      );
      await writeFile(secondWalReleasePath, "released\n", { flag: "wx" });
      record({ type: "gated-second-wal-release-written" });

      await waitFor(
        () =>
          transcript.filter(({ event }) => event.type === "exec-restored").length ===
          CONTENDER_COUNT,
        childDeadlineAt,
        "every contender to restore Database.prototype.exec",
        transcript,
        children,
      );

      const outcomes = await Promise.all(children.map((child) => reap(child, record)));
      const violations: string[] = [];
      const requireInvariant = (condition: boolean, message: string): void => {
        if (!condition) violations.push(message);
      };
      const acquiredIndex = eventIndex(transcript, (event) => event.type === "owner-lock-acquired");
      const requestIndex = eventIndex(transcript, (event) => event.type === "release-request");
      const releasedIndex = eventIndex(transcript, (event) => event.type === "owner-released");
      const ackIndex = eventIndex(transcript, (event) => event.type === "release-ack-written");

      requireInvariant(acquiredIndex >= 0, "owner never reported lock acquisition");
      requireInvariant(
        acquiredIndex < requestIndex && requestIndex < releasedIndex && releasedIndex < ackIndex,
        "release ordering must be lock-acquired < request < owner-released < ack-written",
      );
      requireInvariant(
        eventIndex(transcript, (event) => event.type === "legacy-control-result") < requestIndex,
        "legacy control must observe the conflict while the owner holds the lock",
      );

      const legacyEvent = transcript.find(
        ({ event }) => event.type === "legacy-control-result",
      )?.event;
      requireInvariant(
        legacyEvent?.type === "legacy-control-result" &&
          legacyEvent.walAttempts === 1 &&
          legacyEvent.busyTimeoutInstalled === false &&
          legacyEvent.primaryErrno === 5 &&
          (legacyEvent.code === "SQLITE_BUSY" || legacyEvent.code === "SQLITE_BUSY_RECOVERY") &&
          legacyEvent.callSite === LEGACY_WAL_CALL_SITE,
        "legacy journal-before-timeout control must make one exact busy WAL call",
      );

      for (const { contenderId } of contenders) {
        const own = transcript.filter(
          ({ event }) => "contenderId" in event && event.contenderId === contenderId,
        );
        const first = (type: ChildEvent["type"]): number =>
          eventIndex(
            transcript,
            (event) =>
              event.type === type && "contenderId" in event && event.contenderId === contenderId,
          );
        const preIndex = first("pre-wal-ready");
        const timeoutIndex = first("busy-timeout-installed");
        const heldIndex = first("first-wal-busy-held");
        const observedIndex = first("release-ack-observed");
        const rethrownIndex = first("first-wal-busy-rethrown");
        const restoredIndex = first("exec-restored");
        requireInvariant(
          acquiredIndex < preIndex && preIndex < heldIndex && heldIndex < requestIndex,
          `${contenderId} must reach first-wal-busy-held while the owner retains the lock`,
        );
        requireInvariant(
          ackIndex < observedIndex &&
            observedIndex < rethrownIndex &&
            rethrownIndex < restoredIndex,
          `${contenderId} must not rethrow until request, owner release, and ack creation complete`,
        );

        const ownEvents = own.map(({ event }) => event);
        const attempts = ownEvents.filter((event) => event.type === "wal-attempt");
        const firstAttemptIndex = eventIndex(
          transcript,
          (event) =>
            event.type === "wal-attempt" &&
            event.contenderId === contenderId &&
            event.attempt === 1,
        );
        const secondAttemptIndex = eventIndex(
          transcript,
          (event) =>
            event.type === "wal-attempt" &&
            event.contenderId === contenderId &&
            event.attempt === 2,
        );
        requireInvariant(attempts.length >= 2, `${contenderId} must retry WAL after first busy`);
        requireInvariant(
          attempts[0]?.busyTimeoutInstalled === true,
          `${contenderId} must install busy_timeout before WAL attempt 1`,
        );
        requireInvariant(
          acquiredIndex < timeoutIndex &&
            timeoutIndex < preIndex &&
            preIndex < firstAttemptIndex &&
            firstAttemptIndex < heldIndex,
          `${contenderId} must report busy-timeout installation before WAL attempt 1`,
        );
        requireInvariant(
          ackIndex < rethrownIndex &&
            rethrownIndex < secondAttemptIndex &&
            secondAttemptIndex < restoredIndex,
          `${contenderId} WAL attempt 2 must begin after owner release and release acknowledgement`,
        );

        const held = own
          .map(({ event }) => event)
          .find((event) => event.type === "first-wal-busy-held");
        requireInvariant(
          held?.type === "first-wal-busy-held" &&
            held.attempt === 1 &&
            held.busyTimeoutInstalled === true &&
            held.primaryErrno === 5 &&
            (held.code === "SQLITE_BUSY" || held.code === "SQLITE_BUSY_RECOVERY") &&
            held.callSite === PUBLIC_WAL_CALL_SITE,
          `${contenderId} must hold the exact first WAL busy error after timeout installation`,
        );
        const succeeded = ownEvents.find((event) => event.type === "initializer-succeeded");
        requireInvariant(
          succeeded?.type === "initializer-succeeded" &&
            succeeded.walAttempts === attempts.length &&
            succeeded.elapsedMs <= PUBLIC_INITIALIZER_CEILING_MS,
          `${contenderId} public initializer must succeed within its ceiling`,
        );
        requireEventualWalSuccess(requireInvariant, contenderId, ownEvents);
        if (contenderId === gatedContenderId) {
          requireInvariant(
            formerExactSecondSuccessPredicate(ownEvents) === FORMER_EXACT_SECOND_VIOLATION,
            "gated contender must make the former exact-attempt-2 predicate report its expected violation",
          );
        }
        requireInvariant(
          !own.some(({ event }) => event.type === "initializer-error"),
          `${contenderId} public initializer propagated the captured first WAL busy error`,
        );
        const restored = own
          .map(({ event }) => event)
          .find((event) => event.type === "exec-restored");
        requireInvariant(
          restored?.type === "exec-restored" && restored.restored,
          `${contenderId} must restore Database.prototype.exec in finally`,
        );
      }

      const gatedSecondHeldIndex = eventIndex(
        transcript,
        (event) =>
          event.type === "second-wal-execution-held" && event.contenderId === gatedContenderId,
      );
      const peerSecondSucceededIndex = eventIndex(
        transcript,
        (event) =>
          event.type === "wal-attempt-succeeded" &&
          event.contenderId === peerContenderId &&
          event.attempt === 2 &&
          event.execution === "real",
      );
      const peerReleaseAckWrittenIndex = eventIndex(
        transcript,
        (event) => event.type === "peer-release-ack-written",
      );
      const gatedSecondReleaseWrittenIndex = eventIndex(
        transcript,
        (event) => event.type === "gated-second-wal-release-written",
      );
      const gatedSecondReleaseObservedIndex = eventIndex(
        transcript,
        (event) =>
          event.type === "second-wal-release-observed" && event.contenderId === gatedContenderId,
      );
      const gatedInjectedBusyIndex = eventIndex(
        transcript,
        (event) =>
          event.type === "fixture-second-wal-busy-injected" &&
          event.contenderId === gatedContenderId &&
          event.attempt === 2 &&
          event.primaryErrno === 5 &&
          event.code === "SQLITE_BUSY",
      );
      const gatedThirdSucceededIndex = eventIndex(
        transcript,
        (event) =>
          event.type === "wal-attempt-succeeded" &&
          event.contenderId === gatedContenderId &&
          event.attempt === 3 &&
          event.execution === "real",
      );
      requireInvariant(
        ackIndex < gatedSecondHeldIndex &&
          gatedSecondHeldIndex < peerReleaseAckWrittenIndex &&
          peerReleaseAckWrittenIndex < peerSecondSucceededIndex &&
          peerSecondSucceededIndex < gatedSecondReleaseWrittenIndex &&
          gatedSecondReleaseWrittenIndex < gatedSecondReleaseObservedIndex &&
          gatedSecondReleaseObservedIndex < gatedInjectedBusyIndex &&
          gatedInjectedBusyIndex < gatedThirdSucceededIndex,
        "owner acknowledgement must precede the held retry, peer real attempt 2, fixture busy release, and gated real attempt 3",
      );

      outcomes.forEach((outcome, index) => {
        requireInvariant(
          outcome.exitCode === 0,
          `${children[index]?.childName ?? String(index)} exited ${String(outcome.exitCode)}`,
        );
        requireInvariant(
          outcome.stderr === "",
          `${children[index]?.childName ?? String(index)} stderr: ${outcome.stderr.trim()}`,
        );
        requireInvariant(
          outcome.elapsedMs <= CHILD_DEADLINE_MS,
          `${children[index]?.childName ?? String(index)} exceeded its child deadline`,
        );
        requireInvariant(
          outcome.deadlineReport === undefined,
          outcome.deadlineReport ?? `${children[index]?.childName ?? String(index)} deadline`,
        );
      });
      requireInvariant(
        transcript.filter(({ event }) => event.type === "child-reaped").length === children.length,
        "every spawned child must be reaped",
      );

      expect(violations, formatTranscript(transcript)).toEqual([]);
    } finally {
      await Promise.all(children.map((child) => terminateAndReap(child, record)));
      await rm(root, { recursive: true, force: true });
    }
  },
  TEST_DEADLINE_MS,
);
