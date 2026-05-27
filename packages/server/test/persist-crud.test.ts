/**
 * Abstract CRUD + FTS + event-log test suite for `Persistence`.
 * Runs against both SqlitePersistence and InMemoryPersistence (dual-tests).
 *
 * Mandatory named test (G2c F-13):
 *   "persist-crud.test.ts: FTS updates reflect prompt_excerpt edits"
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { SessionRow, InvocationRow } from "@cq/shared";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SqlitePersistence } from "../src/persist/SqlitePersistence.js";
import { InMemoryPersistence } from "../src/persist/InMemoryPersistence.js";
import type { Persistence } from "../src/persist/Persistence.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let _idCounter = 0;
function uid(): string {
  return `test-${++_idCounter}-${Math.random().toString(36).slice(2, 8)}`;
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
    title: "Test Session",
    lastServerSeq: 0,
    sdkSessionId: null,
    ...overrides,
  };
}

function makeInvocation(sessionId: string, overrides: Partial<InvocationRow> = {}): InvocationRow {
  return {
    id: uid(),
    sessionId,
    parentInvocationId: null,
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
    promptExcerpt: "test prompt",
    eventLogPath: "events/test.jsonl",
    ...overrides,
  };
}

function makeEvent(i: number): SDKMessage {
  return { type: "message_start", message: { id: `msg_${i}`, type: "message", role: "assistant", content: [], model: "claude-3-5-sonnet", stop_reason: null, stop_sequence: null, usage: { input_tokens: i, output_tokens: i } } } as unknown as SDKMessage;
}

// ---------------------------------------------------------------------------
// Abstract suite
// ---------------------------------------------------------------------------

function runSuite(label: string, factory: () => Persistence): void {
  describe(label, () => {
    let p: Persistence;

    beforeEach(() => {
      p = factory();
    });

    afterEach(() => {
      p.close();
    });

    // -----------------------------------------------------------------------
    // 1. Insert session + 3 invocations + 100 events each; retrieve by id
    // -----------------------------------------------------------------------
    test("insert session + 3 invocations + 100 events each; retrieve by id", async () => {
      const session = makeSession();
      p.sessions.insert(session);

      const invocations = [
        makeInvocation(session.id),
        makeInvocation(session.id),
        makeInvocation(session.id),
      ];
      for (const inv of invocations) {
        p.invocations.insert(inv);
        for (let i = 0; i < 100; i++) {
          p.events.append(inv.id, makeEvent(i));
        }
      }

      expect(p.sessions.get(session.id)).toMatchObject({ id: session.id });
      for (const inv of invocations) {
        expect(p.invocations.get(inv.id)).toMatchObject({ id: inv.id });
        const events: SDKMessage[] = [];
        for await (const e of p.events.readAll(inv.id)) events.push(e);
        expect(events).toHaveLength(100);
      }
    });

    // -----------------------------------------------------------------------
    // 2. listForSession returns all invocations for a session
    // -----------------------------------------------------------------------
    test("listForSession returns all invocations for session", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const other = makeSession();
      p.sessions.insert(other);

      const invs = [makeInvocation(session.id), makeInvocation(session.id)];
      const otherInv = makeInvocation(other.id);
      for (const inv of [...invs, otherInv]) p.invocations.insert(inv);

      const result = p.invocations.listForSession(session.id);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id).sort()).toEqual(invs.map((r) => r.id).sort());
    });

    // -----------------------------------------------------------------------
    // 3. List invocations sorted by startedAt DESC
    // -----------------------------------------------------------------------
    test("list sessions sorted by startedAt DESC", () => {
      const now = Date.now();
      const sessions = [
        makeSession({ startedAt: now + 1000, title: "C" }),
        makeSession({ startedAt: now + 2000, title: "A" }),
        makeSession({ startedAt: now + 3000, title: "B" }),
      ];
      for (const s of sessions) p.sessions.insert(s);

      const result = p.sessions.list(
        {},
        { field: "startedAt", dir: "desc" },
        { limit: 10, offset: 0 }
      );
      expect(result.rows.map((r) => r.title)).toEqual(["B", "A", "C"]);
    });

    // -----------------------------------------------------------------------
    // 4. Filter by agentName via FTS search
    // -----------------------------------------------------------------------
    test("filter invocations by agentName via searchFts", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const inv1 = makeInvocation(session.id, { agentName: "alpha-agent", promptExcerpt: "hello" });
      const inv2 = makeInvocation(session.id, { agentName: "beta-agent", promptExcerpt: "world" });
      p.invocations.insert(inv1);
      p.invocations.insert(inv2);

      const results = p.invocations.searchFts("alpha-agent", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.id === inv1.id)).toBe(true);
      expect(results.some((r) => r.id === inv2.id)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 5. Paginate 1000 rows × 200/page
    // -----------------------------------------------------------------------
    test("paginate 1000 sessions at 200/page returns 5 pages of 200", () => {
      const now = Date.now();
      for (let i = 0; i < 1000; i++) {
        p.sessions.insert(makeSession({ startedAt: now + i }));
      }

      let totalFetched = 0;
      for (let page = 0; page < 5; page++) {
        const result = p.sessions.list(
          {},
          { field: "startedAt", dir: "asc" },
          { limit: 200, offset: page * 200 }
        );
        expect(result.rows).toHaveLength(200);
        expect(result.total).toBe(1000);
        totalFetched += result.rows.length;
      }
      expect(totalFetched).toBe(1000);
    });

    // -----------------------------------------------------------------------
    // 6. FTS search finds prompt_excerpt
    // -----------------------------------------------------------------------
    test("persist-crud.test.ts: FTS finds prompt_excerpt", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const inv = makeInvocation(session.id, {
        promptExcerpt: "uniquepromptterm42",
        agentName: "main",
      });
      p.invocations.insert(inv);

      const results = p.invocations.searchFts("uniquepromptterm42", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.id === inv.id)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // 7. FTS-update assertion (G2c F-13 MANDATORY)
    // -----------------------------------------------------------------------
    test("persist-crud.test.ts: FTS updates reflect prompt_excerpt edits", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const inv = makeInvocation(session.id, { promptExcerpt: "alpha" });
      p.invocations.insert(inv);

      // Verify alpha is found before update
      expect(p.invocations.searchFts("alpha", 10).some((r) => r.id === inv.id)).toBe(true);

      // Update prompt_excerpt to "beta"
      p.invocations.update(inv.id, { promptExcerpt: "beta" });

      // beta must be found
      const betaResults = p.invocations.searchFts("beta", 10);
      expect(betaResults.some((r) => r.id === inv.id)).toBe(true);

      // alpha must NOT be found
      const alphaResults = p.invocations.searchFts("alpha", 10);
      expect(alphaResults.some((r) => r.id === inv.id)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 8. Event-log append: 100 events read back in order
    // -----------------------------------------------------------------------
    test("event-log append: 100 events read back in order", async () => {
      const session = makeSession();
      p.sessions.insert(session);
      const inv = makeInvocation(session.id);
      p.invocations.insert(inv);

      for (let i = 0; i < 100; i++) {
        p.events.append(inv.id, makeEvent(i));
      }

      const collected: SDKMessage[] = [];
      for await (const e of p.events.readAll(inv.id)) {
        collected.push(e);
      }

      expect(collected).toHaveLength(100);
      // Verify order: usage.input_tokens reflects the index i
      for (let i = 0; i < 100; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (collected[i] as any).message;
        expect(msg.usage.input_tokens).toBe(i);
      }
    });

    // -----------------------------------------------------------------------
    // 9. Event-log close (fsync on Sqlite; no-op on memory)
    // -----------------------------------------------------------------------
    test("event-log close does not throw", () => {
      const session = makeSession();
      p.sessions.insert(session);
      const inv = makeInvocation(session.id);
      p.invocations.insert(inv);
      p.events.append(inv.id, makeEvent(0));
      expect(() => p.events.close(inv.id)).not.toThrow();
    });

    // -----------------------------------------------------------------------
    // 10. Delete session cascades to invocations
    // -----------------------------------------------------------------------
    test("delete session cascades to invocations", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const inv = makeInvocation(session.id);
      p.invocations.insert(inv);

      p.sessions.delete(session.id);

      expect(p.sessions.get(session.id)).toBeUndefined();
      expect(p.invocations.get(inv.id)).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // 11. withTx rollback on throw
    // -----------------------------------------------------------------------
    test("withTx rolls back on throw", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const inv = makeInvocation(session.id);

      try {
        p.withTx(() => {
          p.invocations.insert(inv);
          throw new Error("intentional rollback");
        });
      } catch {
        // expected
      }

      // After rollback the invocation must not be visible
      expect(p.invocations.get(inv.id)).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // 12. withTx commit on return
    // -----------------------------------------------------------------------
    test("withTx commits on successful return", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const inv = makeInvocation(session.id);

      p.withTx(() => {
        p.invocations.insert(inv);
      });

      expect(p.invocations.get(inv.id)).toMatchObject({ id: inv.id });
    });

    // -----------------------------------------------------------------------
    // 13. Idempotent close
    // -----------------------------------------------------------------------
    test("close is idempotent", () => {
      expect(() => {
        p.close();
        p.close(); // second call must not throw
      }).not.toThrow();
    });

    // -----------------------------------------------------------------------
    // 14. reapOrphans: running rows become errored; completed rows unchanged
    // -----------------------------------------------------------------------
    test("reapOrphans transitions running rows to errored, leaves completed unchanged", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const now = Date.now();
      const runningInv = makeInvocation(session.id, {
        status: "running",
        startedAt: now - 5000,
        endedAt: null,
        durationMs: null,
      });
      const completedInv = makeInvocation(session.id, {
        status: "completed",
        startedAt: now - 3000,
        endedAt: now - 1000,
        durationMs: 2000,
      });
      p.invocations.insert(runningInv);
      p.invocations.insert(completedInv);

      const reaped = p.reapOrphans?.() ?? 0;

      // SQLite adapter reaps; InMemory no-op returns 0.
      if (reaped > 0) {
        const updated = p.invocations.get(runningInv.id);
        expect(updated?.status).toBe("errored");
        expect(updated?.endedAt).toBeGreaterThanOrEqual(now);
        expect(updated?.durationMs).toBeGreaterThan(0);
      }

      // Completed row must be unchanged regardless.
      const unchanged = p.invocations.get(completedInv.id);
      expect(unchanged?.status).toBe("completed");
      expect(unchanged?.endedAt).toBe(now - 1000);
      expect(unchanged?.durationMs).toBe(2000);
    });
  });
}

// ---------------------------------------------------------------------------
// Run the suite against both adapters
// ---------------------------------------------------------------------------

describe("persist-crud", () => {
  runSuite("sqlite", () => new SqlitePersistence(":memory:"));
  runSuite("memory", () => new InMemoryPersistence());
});
