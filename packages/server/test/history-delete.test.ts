/**
 * history-delete.test.ts — end-to-end delete tests for `history.delete`.
 *
 * Case 1: Insert a session with 3 nested invocations (each with a JSONL file
 *   written via `events.append`); delete session → SQLite has 0 rows in the
 *   session + invocation tables; 0 JSONL files remain.
 *
 * Case 2: Insert 1 session + 2 invocations; delete one invocation → the other
 *   persists; only that invocation's JSONL file is gone.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionRow, InvocationRow } from "@cq/shared";
import { SqlitePersistence } from "../src/persist/SqlitePersistence.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let _counter = 0;
function uid(): string {
  // produce deterministic UUIDs for tests
  const n = ++_counter;
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: uid(),
    startedAt: Date.now(),
    endedAt: null,
    cwd: "/tmp/test",
    model: "claude-3-5-sonnet",
    permissionMode: "default",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheRead: 0,
    totalCacheCreate: 0,
    totalCostUsd: 0,
    endedReason: null,
    title: "Test",
    lastServerSeq: 0,
    sdkSessionId: null,
    platform: "claude" as const,
    effort: "none" as const,
    ...overrides,
  };
}

function makeInvocation(
  sessionId: string,
  eventsDir: string,
  overrides: Partial<InvocationRow> = {},
): InvocationRow {
  const id = uid();
  return {
    id,
    sessionId,
    parentInvocationId: null,
    resumedFromInvocationId: null,
    agentName: "main",
    agentId: null,
    taskId: null,
    toolUseId: null,
    model: "claude-3-5-sonnet",
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    status: "running",
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    promptExcerpt: "test",
    // The SqliteEventLog resolves paths as `${eventsDir}/${invocationId}.jsonl`
    eventLogPath: join(eventsDir, `${id}.jsonl`),
    ownerPid: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSDKEvent(i: number): import("@anthropic-ai/claude-agent-sdk").SDKMessage {
  return {
    type: "message_start",
    message: {
      id: `msg_${i}`,
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-3-5-sonnet",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: i, output_tokens: i },
    },
  } as unknown as import("@anthropic-ai/claude-agent-sdk").SDKMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("history-delete", () => {
  const instances: SqlitePersistence[] = [];

  afterEach(() => {
    for (const p of instances.splice(0)) p.close();
  });

  function makePersistence(): { p: SqlitePersistence; eventsDir: string } {
    const eventsDir = mkdtempSync(join(tmpdir(), "cq-del-test-"));
    const p = new SqlitePersistence(":memory:", eventsDir);
    instances.push(p);
    return { p, eventsDir };
  }

  // -----------------------------------------------------------------------
  // Case 1: delete session → 0 rows, 0 JSONL files
  // -----------------------------------------------------------------------
  test("session delete removes session row, all invocation rows, and all JSONL files", async () => {
    const { p, eventsDir } = makePersistence();

    const session = makeSession();
    p.sessions.insert(session);

    // Three invocations, each with one event appended (creates JSONL file).
    const invocations = [
      makeInvocation(session.id, eventsDir),
      makeInvocation(session.id, eventsDir),
      makeInvocation(session.id, eventsDir),
    ];
    for (const inv of invocations) {
      p.invocations.insert(inv);
      p.events.append(inv.id, makeSDKEvent(0));
    }

    // Verify files exist before delete.
    for (const inv of invocations) {
      expect(existsSync(inv.eventLogPath)).toBe(true);
    }

    // Delete the session — should cascade and clean up JSONL files.
    p.sessions.delete(session.id);

    // DB: session and all invocations gone.
    expect(p.sessions.get(session.id)).toBeUndefined();
    for (const inv of invocations) {
      expect(p.invocations.get(inv.id)).toBeUndefined();
    }

    // Filesystem: all JSONL files removed.
    for (const inv of invocations) {
      expect(existsSync(inv.eventLogPath)).toBe(false);
    }
  });

  // -----------------------------------------------------------------------
  // Case 2: delete one invocation → other persists; only that JSONL gone
  // -----------------------------------------------------------------------
  test("invocation delete removes only that row and JSONL; sibling invocation untouched", async () => {
    const { p, eventsDir } = makePersistence();

    const session = makeSession();
    p.sessions.insert(session);

    const invA = makeInvocation(session.id, eventsDir);
    const invB = makeInvocation(session.id, eventsDir);
    p.invocations.insert(invA);
    p.invocations.insert(invB);

    // Write events so JSONL files are created.
    p.events.append(invA.id, makeSDKEvent(1));
    p.events.append(invB.id, makeSDKEvent(2));

    expect(existsSync(invA.eventLogPath)).toBe(true);
    expect(existsSync(invB.eventLogPath)).toBe(true);

    // Delete only invA.
    p.invocations.delete(invA.id);

    // invA gone; invB persists.
    expect(p.invocations.get(invA.id)).toBeUndefined();
    expect(p.invocations.get(invB.id)).toMatchObject({ id: invB.id });

    // JSONL for invA removed; JSONL for invB still present.
    expect(existsSync(invA.eventLogPath)).toBe(false);
    expect(existsSync(invB.eventLogPath)).toBe(true);

    // Session itself untouched.
    expect(p.sessions.get(session.id)).toMatchObject({ id: session.id });
  });
});
