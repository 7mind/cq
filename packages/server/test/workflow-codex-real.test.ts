/**
 * workflow-codex-real.test.ts (codexwf) — REAL Codex producer through the relay.
 *
 * Boots a REAL cq server (which constructs the real CodexProducer pointed at
 * its own internal-WS channel + cq-mcp), then drives a real `/plan` producer
 * dispatch on platform="codex" via `workflow.startPlan`. The full real path is
 * exercised: headless Codex thread → cq-mcp child's `submit_workflow_phase`
 * tool → workflow.submit over the internal WS → WorkflowSubmitProxy validates
 * → the HARNESS writes the goals + spec milestone + questions to disk.
 *
 * Auth gate: skips cleanly when no codex login state (~/.codex/auth.json) and
 * no OPENAI_API_KEY are available. Asserts the on-disk effect (the strongest
 * signal that cq-mcp was genuinely spawned and the relay genuinely ran):
 *   - a goal row in docs/goals.md with status=clarifying,
 *   - a spec milestone linked,
 *   - at least one question under it.
 *
 * The codex CLI is slower than Claude (cold start + a tool-use round-trip), so
 * the timeout is generous. This test documents real-Codex reliability for the
 * producer phase; the deterministic fake-driven proof lives in
 * workflow-codex-relay-integration.test.ts.
 */

import { describe, it, expect } from "bun:test";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { startServer } from "../src/server";
import { FsLedgerStore, GOALS_LEDGER, QUESTIONS_LEDGER } from "@cq/ledger";
import type { Logger } from "../src/log/logger";

/**
 * Mirror of e2e/fixtures/codexAuth.hasCodexAuth (kept local so the server
 * package's tsconfig need not reference the e2e package).
 */
function hasCodexAuth(): boolean {
  const key = process.env["OPENAI_API_KEY"];
  if (key !== undefined && key !== "") return true;
  if (process.env["CQ_E2E_RUN_CODEX"] === "1") return true;
  const homeDir = os.homedir();
  if (homeDir === "" || homeDir === undefined) return false;
  try {
    return fsSync.statSync(path.join(homeDir, ".codex", "auth.json")).isFile();
  } catch {
    return false;
  }
}

/** A stderr logger so cq-mcp connect + relay diagnostics are visible. */
const debugLogger: Logger = {
  debug: () => {},
  info: (msg, extra) => process.stderr.write(`[info] ${msg} ${extra ? JSON.stringify(extra) : ""}\n`),
  warn: (msg, extra) => process.stderr.write(`[warn] ${msg} ${extra ? JSON.stringify(extra) : ""}\n`),
  error: (msg, extra) => process.stderr.write(`[error] ${msg} ${extra ? JSON.stringify(extra) : ""}\n`),
};

describe("workflow Codex relay — REAL Codex producer lands the goal on disk", () => {
  it(
    "drives a real /plan producer on platform=codex and writes goal+spec+questions",
    async () => {
      if (!hasCodexAuth()) {
        // No codex auth in this environment — skip (documented in the brief).
        // bun:test has no runtime skip; assert-true keeps the suite green.
        expect(true).toBe(true);
        return;
      }

      const cwd = await mkdtemp(path.join(tmpdir(), "cq-codexwf-real-"));
      const dbPath = path.join(cwd, "cq.sqlite");
      const webOutdir = path.join(cwd, "web"); // unused by the producer path

      const running = await startServer({
        host: "127.0.0.1",
        port: 0,
        webOutdir,
        cwd,
        dbPath,
        logger: debugLogger,
      });

      try {
        const events: Array<{ status: string; detail?: string }> = [];
        const res = await running.workflow.startPlan(
          { text: "build a tiny command-line todo app", platform: "codex" },
          (e) => events.push({ status: e.status, ...(e.detail !== undefined ? { detail: e.detail } : {}) }),
        );
        if (res.outcome === "errored") {
          // eslint-disable-next-line no-console
          console.error("REAL CODEX PRODUCER ERRORED. reason=", res.reason, "events=", JSON.stringify(events));
        }

        // Document the outcome explicitly: a true technical wall (the model
        // never calls the submit tool) surfaces as outcome="errored" with the
        // producer's actionable message — fail loudly rather than green-fake.
        expect(
          res.outcome,
          `real Codex producer outcome was ${res.outcome}; events=${JSON.stringify(events)}`,
        ).toBe("questions_ready");
        if (res.outcome !== "questions_ready") return;

        const goalId = res.goalId;
        // Re-read from a FRESH store so in-memory state cannot mask the write.
        const verify = new FsLedgerStore({ root: cwd });
        await verify.init();
        try {
          const goal = verify.fetchItem(GOALS_LEDGER, goalId);
          expect(goal.status).toBe("clarifying");
          expect(String(goal.fields["description"]).length).toBeGreaterThan(0);
          const ms = goal.fields["milestones"] as string[];
          expect(Array.isArray(ms)).toBe(true);
          expect(ms.length).toBeGreaterThanOrEqual(1);
          const specId = ms[0]!;
          const questions = verify.listMilestoneItems(specId)[QUESTIONS_LEDGER] ?? [];
          expect(questions.length).toBeGreaterThanOrEqual(1);
          expect(String(questions[0]!.fields["question"]).length).toBeGreaterThan(0);
        } finally {
          await verify.dispose();
        }
      } finally {
        await running.workflow.whenDrained().catch(() => undefined);
        await running.stop();
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    240_000,
  );

  it(
    "drives one real clarify-reviewer phase via the relay (phase-subagent path)",
    async () => {
      if (!hasCodexAuth()) {
        expect(true).toBe(true);
        return;
      }

      const cwd = await mkdtemp(path.join(tmpdir(), "cq-codexwf-clarify-"));
      const dbPath = path.join(cwd, "cq.sqlite");
      const webOutdir = path.join(cwd, "web");

      const running = await startServer({
        host: "127.0.0.1",
        port: 0,
        webOutdir,
        cwd,
        dbPath,
        logger: debugLogger,
      });

      try {
        const events: Array<{ status: string }> = [];
        const res = await running.workflow.startPlan(
          { text: "build a tiny command-line todo app", platform: "codex" },
          (e) => events.push({ status: e.status }),
        );
        expect(res.outcome, `producer outcome=${res.outcome}`).toBe("questions_ready");
        if (res.outcome !== "questions_ready") return;
        const goalId = res.goalId;

        // Answer the first batch → auto-advances into the REAL clarify-reviewer
        // phase subagent (a non-producer phase). We do NOT require convergence
        // to `planned` — the real reviewer's satisfaction is its own judgement
        // and is exercised deterministically in the fake-driven full-loop test.
        // We assert the clarify-reviewer phase RAN via the relay (the goal left
        // its initial position: it either advanced toward planning or the
        // reviewer wrote a fresh question batch — both prove the phase ran).
        const snap = running.workflow.buildGoalsSnapshot().goals.find((g) => g.id === goalId)!;
        const firstBatch = snap.milestones
          .flatMap((m) => m.questions)
          .filter((q) => q.status === "open")
          .map((q) => q.id);
        for (const qid of firstBatch) {
          await running.workflow.submitAnswer(
            qid,
            "Single-file Python 3, in-memory list, commands add/list/done. No persistence.",
          );
        }

        // Wait for the clarify-reviewer dispatch to settle.
        await Bun.sleep(2_000);
        await running.workflow.whenDrained().catch(() => undefined);
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const g = running.workflow.buildGoalsSnapshot().goals.find((x) => x.id === goalId)!;
          // The clarify-reviewer either advanced the goal to planning/planned OR
          // raised a NEW question batch (more questions than the first). Either
          // is proof the phase ran via the relay.
          const allQ = g.milestones.flatMap((m) => m.questions);
          if (g.status === "planning" || g.status === "planned" || allQ.length > firstBatch.length) {
            break;
          }
          await Bun.sleep(2_000);
        }

        const g = running.workflow.buildGoalsSnapshot().goals.find((x) => x.id === goalId)!;
        const allQ = g.milestones.flatMap((m) => m.questions);
        const reviewerRan =
          g.status === "planning" || g.status === "planned" || allQ.length > firstBatch.length;
        expect(
          reviewerRan,
          `clarify-reviewer did not run via the relay; status=${g.status}, q=${allQ.length}, firstBatch=${firstBatch.length}, events=${JSON.stringify(events.map((e) => e.status))}`,
        ).toBe(true);
      } finally {
        await running.workflow.whenDrained().catch(() => undefined);
        await running.stop();
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    300_000,
  );
});
