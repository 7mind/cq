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
import { tryAcquireDbLock } from "../src/persist/cqLock.js";

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
    platform: "claude" as const,
    effort: "none" as const,
    ...overrides,
  };
}

function makeInvocation(sessionId: string, overrides: Partial<InvocationRow> = {}): InvocationRow {
  return {
    id: uid(),
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
    promptExcerpt: "test prompt",
    eventLogPath: "events/test.jsonl",
    ownerPid: null,
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
    // gear-2: session.platform + session.effort round-trip
    // -----------------------------------------------------------------------
    test("gear-2: platform + effort survive insert/get round-trip", () => {
      const claudeSession = makeSession({ platform: "claude", effort: "high" });
      const codexSession = makeSession({ platform: "codex", effort: "max" });
      p.sessions.insert(claudeSession);
      p.sessions.insert(codexSession);
      expect(p.sessions.get(claudeSession.id)).toMatchObject({
        platform: "claude",
        effort: "high",
      });
      expect(p.sessions.get(codexSession.id)).toMatchObject({
        platform: "codex",
        effort: "max",
      });
    });

    test("gear-2: update can mutate platform and effort fields", () => {
      const session = makeSession({ platform: "claude", effort: "none" });
      p.sessions.insert(session);
      p.sessions.update(session.id, { platform: "codex", effort: "medium" });
      expect(p.sessions.get(session.id)).toMatchObject({
        platform: "codex",
        effort: "medium",
      });
    });

    test("gear-2: HistoryRow surfaces platform and effort from the joined session", () => {
      const session = makeSession({ platform: "codex", effort: "low" });
      p.sessions.insert(session);
      p.invocations.insert(makeInvocation(session.id));
      const result = p.invocations.list({}, { field: "startedAt", dir: "desc" }, { offset: 0, limit: 10 });
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0]!;
      expect(row.platform).toBe("codex");
      expect(row.effort).toBe("low");
    });

    // -----------------------------------------------------------------------
    // gcn1-1: session.approvalPolicy round-trip + HistoryRow surface
    // -----------------------------------------------------------------------
    test("gcn1-1: approvalPolicy survives insert/get round-trip", () => {
      const codex = makeSession({ platform: "codex", effort: "high", approvalPolicy: "on-request" });
      const claude = makeSession({ platform: "claude", effort: "none", approvalPolicy: null });
      p.sessions.insert(codex);
      p.sessions.insert(claude);
      expect(p.sessions.get(codex.id)).toMatchObject({ approvalPolicy: "on-request" });
      expect(p.sessions.get(claude.id)).toMatchObject({ approvalPolicy: null });
    });

    test("gcn1-1: update can mutate approvalPolicy", () => {
      const session = makeSession({ platform: "codex", effort: "high", approvalPolicy: "on-request" });
      p.sessions.insert(session);
      p.sessions.update(session.id, { approvalPolicy: "never" });
      expect(p.sessions.get(session.id)).toMatchObject({ approvalPolicy: "never" });
      p.sessions.update(session.id, { approvalPolicy: null });
      expect(p.sessions.get(session.id)).toMatchObject({ approvalPolicy: null });
    });

    test("gcn1-1: HistoryRow surfaces approvalPolicy from the joined session", () => {
      const session = makeSession({ platform: "codex", effort: "low", approvalPolicy: "untrusted" });
      p.sessions.insert(session);
      p.invocations.insert(makeInvocation(session.id));
      const result = p.invocations.list({}, { field: "startedAt", dir: "desc" }, { offset: 0, limit: 10 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.approvalPolicy).toBe("untrusted");
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
    // QR-P2: delete invocation cascades to children and grandchildren
    // -----------------------------------------------------------------------
    test("QR-P2: delete parent invocation removes children and grandchildren", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const parent = makeInvocation(session.id, { agentName: "main" });
      const child1 = makeInvocation(session.id, {
        agentName: "sub1",
        parentInvocationId: parent.id,
      });
      const child2 = makeInvocation(session.id, {
        agentName: "sub2",
        parentInvocationId: parent.id,
      });
      const grandchild = makeInvocation(session.id, {
        agentName: "sub1a",
        parentInvocationId: child1.id,
      });

      p.invocations.insert(parent);
      p.invocations.insert(child1);
      p.invocations.insert(child2);
      p.invocations.insert(grandchild);

      // Verify all 4 exist before deletion.
      expect(p.invocations.get(parent.id)).toBeDefined();
      expect(p.invocations.get(child1.id)).toBeDefined();
      expect(p.invocations.get(child2.id)).toBeDefined();
      expect(p.invocations.get(grandchild.id)).toBeDefined();

      p.invocations.delete(parent.id);

      // All 4 rows must be gone.
      expect(p.invocations.get(parent.id)).toBeUndefined();
      expect(p.invocations.get(child1.id)).toBeUndefined();
      expect(p.invocations.get(child2.id)).toBeUndefined();
      expect(p.invocations.get(grandchild.id)).toBeUndefined();
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
    // 14. resumedFromInvocationId round-trips through insert → get
    // -----------------------------------------------------------------------
    test("resumedFromInvocationId round-trips: set value preserved; null preserved", () => {
      const session = makeSession();
      p.sessions.insert(session);

      // First invocation: no resumption
      const firstInv = makeInvocation(session.id, { resumedFromInvocationId: null });
      p.invocations.insert(firstInv);

      // Second invocation: resumed from first
      const secondInv = makeInvocation(session.id, { resumedFromInvocationId: firstInv.id });
      p.invocations.insert(secondInv);

      const fetchedFirst = p.invocations.get(firstInv.id);
      expect(fetchedFirst?.resumedFromInvocationId).toBeNull();

      const fetchedSecond = p.invocations.get(secondInv.id);
      expect(fetchedSecond?.resumedFromInvocationId).toBe(firstInv.id);
    });

    // -----------------------------------------------------------------------
    // D23. list() returns one row per session (latest invocation by startedAt)
    // -----------------------------------------------------------------------
    test("D23: list() returns one row per session — latest invocation wins", () => {
      const now = Date.now();

      // Session 1: three invocations A (original), B (resumed from A), C (resumed from B).
      const session1 = makeSession({ title: "S1" });
      p.sessions.insert(session1);

      const invA = makeInvocation(session1.id, {
        agentName: "main",
        resumedFromInvocationId: null,
        startedAt: now + 1000,
        promptExcerpt: "invA",
      });
      const invB = makeInvocation(session1.id, {
        agentName: "main",
        resumedFromInvocationId: invA.id,
        startedAt: now + 2000,
        promptExcerpt: "invB",
      });
      const invC = makeInvocation(session1.id, {
        agentName: "main",
        resumedFromInvocationId: invB.id,
        startedAt: now + 3000,
        promptExcerpt: "invC",
      });
      p.invocations.insert(invA);
      p.invocations.insert(invB);
      p.invocations.insert(invC);

      // After inserting one session with three invocations, list returns exactly 1 row
      // and that row corresponds to the latest invocation (C).
      const result1 = p.invocations.list(
        {},
        { field: "startedAt", dir: "desc" },
        { limit: 50, offset: 0 },
      );
      expect(result1.total).toBe(1);
      expect(result1.rows).toHaveLength(1);
      expect(result1.rows[0]!.invocationId).toBe(invC.id);

      // Session 2: one invocation D.
      const session2 = makeSession({ title: "S2" });
      p.sessions.insert(session2);

      const invD = makeInvocation(session2.id, {
        agentName: "main",
        resumedFromInvocationId: null,
        startedAt: now + 4000,
        promptExcerpt: "invD",
      });
      p.invocations.insert(invD);

      // Now list returns 2 rows: D (latest session) then C, sorted desc by startedAt.
      const result2 = p.invocations.list(
        {},
        { field: "startedAt", dir: "desc" },
        { limit: 50, offset: 0 },
      );
      expect(result2.total).toBe(2);
      expect(result2.rows).toHaveLength(2);
      expect(result2.rows[0]!.invocationId).toBe(invD.id);
      expect(result2.rows[1]!.invocationId).toBe(invC.id);
    });

    // -----------------------------------------------------------------------
    // D35: list() shows subagent rows as distinct rows; main rows deduped per session
    // -----------------------------------------------------------------------
    test("D35: list() shows subagent row as distinct entry; main invocations deduped per session", () => {
      const now = Date.now();

      const session = makeSession({ title: "S-D35" });
      p.sessions.insert(session);

      // A = top-level main (earlier)
      const invA = makeInvocation(session.id, {
        agentName: "main",
        parentInvocationId: null,
        startedAt: now + 1000,
        promptExcerpt: "main-A",
      });
      // B = subagent child of A
      const invB = makeInvocation(session.id, {
        agentName: "general-purpose",
        parentInvocationId: invA.id,
        startedAt: now + 1500,
        promptExcerpt: "subagent-B",
      });
      // C = main resumed from A (later)
      const invC = makeInvocation(session.id, {
        agentName: "main",
        parentInvocationId: null,
        resumedFromInvocationId: invA.id,
        startedAt: now + 2000,
        promptExcerpt: "main-C",
      });

      p.invocations.insert(invA);
      p.invocations.insert(invB);
      p.invocations.insert(invC);

      const result = p.invocations.list(
        {},
        { field: "startedAt", dir: "desc" },
        { limit: 50, offset: 0 },
      );

      // Two rows: C (latest main, deduped over A) and B (subagent, distinct row).
      expect(result.total).toBe(2);
      expect(result.rows).toHaveLength(2);

      const ids = result.rows.map((r) => r.invocationId);
      expect(ids).toContain(invC.id);
      expect(ids).toContain(invB.id);
      // A must NOT appear (deduped out by C).
      expect(ids).not.toContain(invA.id);

      const subRow = result.rows.find((r) => r.invocationId === invB.id);
      expect(subRow).toBeDefined();
      expect(subRow!.agentName).toBe("general-purpose");
    });

    // -----------------------------------------------------------------------
    // D41. UI settings: get returns defaults on fresh DB
    // -----------------------------------------------------------------------
    test("D41: settings.get returns defaults on fresh persistence", () => {
      const s = p.settings.get();
      expect(s.model).toBeNull();
      expect(s.permissionMode).toBeNull();
      expect(s.hideSdkEvents).toBe(false);
    });

    // -----------------------------------------------------------------------
    // D41. UI settings: set model; get reflects it
    // -----------------------------------------------------------------------
    test("D41: settings.set model; get returns updated model", () => {
      p.settings.set({ model: "claude-opus-4-7" });
      const s = p.settings.get();
      expect(s.model).toBe("claude-opus-4-7");
      expect(s.permissionMode).toBeNull();
      expect(s.hideSdkEvents).toBe(false);
    });

    // -----------------------------------------------------------------------
    // D41. UI settings: set hideSdkEvents; prior model preserved
    // -----------------------------------------------------------------------
    test("D41: settings.set hideSdkEvents; prior model is preserved", () => {
      p.settings.set({ model: "claude-opus-4-7" });
      p.settings.set({ hideSdkEvents: true });
      const s = p.settings.get();
      expect(s.model).toBe("claude-opus-4-7");
      expect(s.hideSdkEvents).toBe(true);
    });

    // -----------------------------------------------------------------------
    // 15. reapOrphans: running rows with a dead ownerPid become stopped;
    //     completed rows unchanged
    // -----------------------------------------------------------------------
    test("reapOrphans transitions running rows to wiped, leaves completed unchanged", () => {
      const session = makeSession();
      p.sessions.insert(session);

      // D42: use a deliberately-dead PID so the reaper picks this row up.
      // PID 999999999 is far above the Linux/macOS max PID (~4M) — guaranteed ESRCH.
      const deadPid = 999999999;

      const now = Date.now();
      const runningInv = makeInvocation(session.id, {
        status: "running",
        startedAt: now - 5000,
        endedAt: null,
        durationMs: null,
        ownerPid: deadPid,
      });
      const completedInv = makeInvocation(session.id, {
        status: "completed",
        startedAt: now - 3000,
        endedAt: now - 1000,
        durationMs: 2000,
        ownerPid: deadPid,
      });
      p.invocations.insert(runningInv);
      p.invocations.insert(completedInv);

      const reaped = p.reapOrphans?.() ?? 0;

      // SQLite adapter reaps; InMemory no-op returns 0.
      if (reaped > 0) {
        const updated = p.invocations.get(runningInv.id);
        expect(updated?.status).toBe("wiped");
        expect(updated?.endedAt).toBeGreaterThanOrEqual(now);
        expect(updated?.durationMs).toBeGreaterThan(0);
      }

      // Completed row must be unchanged regardless.
      const unchanged = p.invocations.get(completedInv.id);
      expect(unchanged?.status).toBe("completed");
      expect(unchanged?.endedAt).toBe(now - 1000);
      expect(unchanged?.durationMs).toBe(2000);
    });

    // -----------------------------------------------------------------------
    // D42. reapOrphans: rows with ownerPid=null are never reaped
    // -----------------------------------------------------------------------
    test("D42: reapOrphans leaves running row with ownerPid=null untouched", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const inv = makeInvocation(session.id, {
        status: "running",
        ownerPid: null,
      });
      p.invocations.insert(inv);

      p.reapOrphans?.();

      const row = p.invocations.get(inv.id);
      expect(row?.status).toBe("running");
    });

    // -----------------------------------------------------------------------
    // D42. reapOrphans: rows owned by our own (alive) PID are never reaped
    // -----------------------------------------------------------------------
    test("D42: reapOrphans leaves running row owned by alive PID untouched", () => {
      const session = makeSession();
      p.sessions.insert(session);

      const inv = makeInvocation(session.id, {
        status: "running",
        ownerPid: process.pid,
      });
      p.invocations.insert(inv);

      p.reapOrphans?.();

      const row = p.invocations.get(inv.id);
      expect(row?.status).toBe("running");
    });

    // -----------------------------------------------------------------------
    // wfhist-1: session.kind round-trip + HistoryRow surfaces it
    // -----------------------------------------------------------------------
    test("wfhist-1: session.kind survives insert/get round-trip (chat default + workflow)", () => {
      const chat = makeSession(); // no kind → reads as "chat"
      const wf = makeSession({ kind: "workflow" });
      p.sessions.insert(chat);
      p.sessions.insert(wf);
      expect(p.sessions.get(chat.id)?.kind).toBe("chat");
      expect(p.sessions.get(wf.id)?.kind).toBe("workflow");
    });

    test("wfhist-1: update can mutate session.kind", () => {
      const s = makeSession();
      p.sessions.insert(s);
      p.sessions.update(s.id, { kind: "workflow" });
      expect(p.sessions.get(s.id)?.kind).toBe("workflow");
    });

    test("wfhist-1: HistoryRow surfaces kind from the joined session", () => {
      const s = makeSession({ kind: "workflow" });
      p.sessions.insert(s);
      p.invocations.insert(makeInvocation(s.id));
      const result = p.invocations.list({}, { field: "startedAt", dir: "desc" }, { offset: 0, limit: 10 });
      expect(result.rows[0]!.kind).toBe("workflow");
    });

    // -----------------------------------------------------------------------
    // wfhist-1: workflow_session link store (goalId → session + root invocation)
    // -----------------------------------------------------------------------
    test("wfhist-1: workflowSessions link + getByGoal round-trip", () => {
      const link = { goalId: "G1", sessionId: uid(), rootInvocationId: uid() };
      p.workflowSessions.link(link);
      expect(p.workflowSessions.getByGoal("G1")).toEqual(link);
      expect(p.workflowSessions.getByGoal("G-absent")).toBeUndefined();
    });

    test("wfhist-1: workflowSessions.link upserts on the same goalId", () => {
      const s1 = uid();
      const s2 = uid();
      p.workflowSessions.link({ goalId: "G1", sessionId: s1, rootInvocationId: "r1" });
      p.workflowSessions.link({ goalId: "G1", sessionId: s2, rootInvocationId: "r2" });
      expect(p.workflowSessions.getByGoal("G1")).toEqual({
        goalId: "G1",
        sessionId: s2,
        rootInvocationId: "r2",
      });
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

// ---------------------------------------------------------------------------
// QR-P1: SqliteEventLog writes via fd (not appendFileSync) so fsync covers bytes
// ---------------------------------------------------------------------------

describe("QR-P1: SqliteEventLog fd-write round-trip via fresh store", () => {
  test("append 10 events, close, reopen via fresh SqlitePersistence, readAll yields all 10", async () => {
    // Use a real temp-dir-backed DB so the events dir is a real directory.
    const tmpDir = mkdtempSync(join(tmpdir(), "cq-p1-test-"));
    const dbFile = join(tmpDir, "p1.db");

    const persA = new SqlitePersistence(dbFile, undefined, undefined, false);
    const session = makeSession();
    persA.sessions.insert(session);
    const inv = makeInvocation(session.id, { eventLogPath: `events/${session.id}.jsonl` });
    persA.invocations.insert(inv);

    for (let i = 0; i < 10; i++) {
      persA.events.append(inv.id, makeEvent(i));
    }
    // close() flushes fsync; this is the moment bytes are durably committed.
    persA.events.close(inv.id);
    persA.close();

    // Re-open via a second persistence instance — fresh InvocationStore + SqliteEventLog.
    const persB = new SqlitePersistence(dbFile, undefined, undefined, false);
    const collected: import("@anthropic-ai/claude-agent-sdk").SDKMessage[] = [];
    for await (const e of persB.events.readAll(inv.id)) {
      collected.push(e);
    }
    persB.close();

    expect(collected).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (collected[i] as any).message;
      expect(msg.usage.input_tokens).toBe(i);
    }
  });
});

// ---------------------------------------------------------------------------
// D29: PID-file lock — tryAcquireDbLock unit tests
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("D29: tryAcquireDbLock", () => {
  // Create a temp dir for lock files; clean it up after each test.
  let tmpDir: string;
  let dbPath: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cq-lock-test-"));
    dbPath = join(tmpDir, "test.db");
    lockPath = `${dbPath}.lock`;
  });

  afterEach(() => {
    // Remove lock file if it still exists (test may have left it).
    try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* ignore */ }
  });

  test("acquires lock when no lock file exists", () => {
    const lock = tryAcquireDbLock(dbPath);
    expect(lock.acquired).toBe(true);
    // Lock file must be present after acquisition.
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
    // Lock file must be removed after release.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("second call returns acquired:false when lock is already held by this process", () => {
    // First acquisition writes our PID. Our PID is alive, so a second attempt sees
    // the file, reads our PID, and process.kill(ourPid, 0) succeeds → not acquired.
    const lockA = tryAcquireDbLock(dbPath);
    expect(lockA.acquired).toBe(true);

    const lockB = tryAcquireDbLock(dbPath);
    expect(lockB.acquired).toBe(false);

    lockA.release();
  });

  test("reclaims stale lock when PID in file is not running", () => {
    // Write a lock file with an almost-certainly-nonexistent PID.
    const stalePid = 2147483647; // max int32 — practically guaranteed not running.
    writeFileSync(lockPath, String(stalePid), "utf8");

    const lock = tryAcquireDbLock(dbPath);
    // The stale lock should be reclaimed.
    expect(lock.acquired).toBe(true);
    lock.release();
  });

  // -------------------------------------------------------------------------
  // R2a: Two concurrent tryAcquireDbLock calls — exactly one acquires
  // -------------------------------------------------------------------------
  test("R2a: two concurrent tryAcquireDbLock calls on the same path; exactly one acquires", async () => {
    // Fire both acquisitions synchronously (they are sync internally).
    // Wrapping in Promise.all ensures we catch any thrown errors.
    const [lockA, lockB] = await Promise.all([
      Promise.resolve(tryAcquireDbLock(dbPath)),
      Promise.resolve(tryAcquireDbLock(dbPath)),
    ]);
    const acquiredCount = [lockA.acquired, lockB.acquired].filter(Boolean).length;
    expect(acquiredCount).toBe(1);
    lockA.release();
    lockB.release();
    // After both release the lock file must be gone.
    expect(existsSync(lockPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // R2b: process.kill throwing EPERM → acquired:false (live foreign-owned process)
  // -------------------------------------------------------------------------
  test("R2b: EPERM from process.kill means the process is alive; lock is NOT reclaimed", () => {
    // Write a lock file with a fake PID. The real PID value does not matter
    // because we monkey-patch process.kill to throw EPERM.
    const fakePid = 12345;
    writeFileSync(lockPath, String(fakePid), "utf8");

    const originalKill = process.kill.bind(process);
    // Temporarily replace process.kill to simulate a foreign-owned live process.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (process as unknown as Record<string, unknown>).kill = (...args: unknown[]) => {
      const err = new Error("Operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    };
    try {
      const lock = tryAcquireDbLock(dbPath);
      // Must NOT reclaim: the PID is alive (just foreign-owned).
      expect(lock.acquired).toBe(false);
      // Lock file must still contain the original PID (not overwritten).
      expect(readFileSync(lockPath, "utf8").trim()).toBe(String(fakePid));
    } finally {
      (process as unknown as Record<string, unknown>).kill = originalKill;
    }
  });

  test("SqlitePersistence A holds lock; opening B on same file-backed DB skips reap", () => {
    // Use a real file-backed DB so the PID lock logic is exercised.
    const dbFile = join(tmpDir, "shared.db");

    // Open A — acquires lock and runs reaper (no orphans on empty DB, so 0 reaped).
    const persA = new SqlitePersistence(dbFile);
    const session = makeSession();
    persA.sessions.insert(session);
    // D42: use a dead ownerPid so the reaper (when it runs) will pick this row up.
    const runningInv = makeInvocation(session.id, {
      status: "running",
      endedAt: null,
      durationMs: null,
      ownerPid: 999999999,
    });
    persA.invocations.insert(runningInv);

    // Open B on the same file. A still holds the lock so B must skip reaping.
    const persB = new SqlitePersistence(dbFile);
    // The running invocation must still be 'running' (B did not reap it).
    const row = persB.invocations.get(runningInv.id);
    expect(row?.status).toBe("running");
    persB.close();

    // Close A — releases the lock.
    persA.close();

    // Open C — reclaims the stale lock and reaps (ownerPid 999999999 is dead).
    const persC = new SqlitePersistence(dbFile);
    const reaped = persC.invocations.get(runningInv.id);
    expect(reaped?.status).toBe("wiped");
    persC.close();
  });

  // -------------------------------------------------------------------------
  // D42. SqlitePersistence with runReaper:false skips the reaper entirely
  // -------------------------------------------------------------------------
  test("D42: SqlitePersistence with runReaper=false skips reaper; default reopening reaps", () => {
    const dbFile = join(tmpDir, "noreaper.db");

    // Open with runReaper=false — insert a running row with a dead ownerPid.
    const persA = new SqlitePersistence(dbFile, undefined, undefined, false);
    const session = makeSession();
    persA.sessions.insert(session);
    const runningInv = makeInvocation(session.id, {
      status: "running",
      endedAt: null,
      durationMs: null,
      ownerPid: 999999999,
    });
    persA.invocations.insert(runningInv);
    persA.close();

    // Reopen with runReaper=false — row must still be 'running' (no reap).
    const persB = new SqlitePersistence(dbFile, undefined, undefined, false);
    const rowB = persB.invocations.get(runningInv.id);
    expect(rowB?.status).toBe("running");
    persB.close();

    // Reopen with default runReaper=true — reaper fires and marks row 'wiped'.
    const persC = new SqlitePersistence(dbFile);
    const rowC = persC.invocations.get(runningInv.id);
    expect(rowC?.status).toBe("wiped");
    persC.close();
  });
});
