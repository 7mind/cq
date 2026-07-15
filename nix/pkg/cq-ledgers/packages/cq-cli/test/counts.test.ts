/**
 * T533 / G76 — the `cq counts` UNCONDITIONAL ledger-summaries emitter
 * contract, cloned from predicates.test.ts (T476 / Q241).
 *
 * `cq counts` mirrors `cq predicates` exactly: NO session resolution and NO
 * marker check — it ALWAYS reads the ledger via the shared
 * `computeLedgerSummaries(store)` engine (T532) and ALWAYS prints
 * `{ ledgers, counts, ledgerSummaries }`, exiting 0.
 *
 * `computeLedgerSummaries` is the SAME function the `enumerate_ledgers` MCP
 * tool calls verbatim (`jsonResult(computeLedgerSummaries(store))` in both
 * `ledgerTools.ts` and `stdioLedgerTools.ts`) — so asserting the emitted
 * `ledgerSummaries` deep-equal `computeLedgerSummaries(store)` on the same
 * root IS asserting deep-equality with the `enumerate_ledgers` MCP tool
 * output for that root.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runCounts, type CountsIo } from "../src/counts.js";
import {
  MILESTONES_AMBIENT_ID,
  createLedgerStore,
  computeLedgerSummaries,
} from "@cq/ledger";

const dirs: string[] = [];
let prevXdgStateHome: string | undefined;
beforeAll(async () => {
  // The runtime store is the out-of-tree xdg primary (T505): point
  // XDG_STATE_HOME at a temp dir so seeded state never touches the host.
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = await makeTmpDir("cq-counts-xdg-");
});
afterAll(async () => {
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Seed a fresh xdg-backed ledger root with known questions/tasks/defects
 * items spread across statuses (including terminal ones), so
 * completedCount/progressTotal are non-trivial for each ledger. The cq.toml
 * pins backend='xdg' with an explicit projectId (the temp root has no git
 * identity) so both the seed and the production path (runCounts →
 * createLedgerStore) resolve the same store.
 */
async function seedKnownLedger(): Promise<string> {
  const root = await makeTmpDir("cq-counts-ledger-");
  await writeFile(
    path.join(root, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(root)}"\n`,
    "utf8",
  );
  const { store } = await createLedgerStore(root);

  // questions: open, answered (x2), withdrawn — completedCount=2 (answered
  // only), progressTotal=3 (itemCount 4 - withdrawn 1).
  await store.createItem("questions", MILESTONES_AMBIENT_ID, {
    status: "open",
    fields: { question: "q1" },
  });
  await store.createItem("questions", MILESTONES_AMBIENT_ID, {
    status: "answered",
    fields: { question: "q2", answer: "a2" },
  });
  await store.createItem("questions", MILESTONES_AMBIENT_ID, {
    status: "answered",
    fields: { question: "q3", answer: "a3" },
  });
  await store.createItem("questions", MILESTONES_AMBIENT_ID, {
    status: "withdrawn",
    fields: { question: "q4" },
  });

  // tasks: done, abandoned, wip, planned — completedCount=2 (done+abandoned),
  // progressTotal=itemCount=4.
  await store.createItem("tasks", MILESTONES_AMBIENT_ID, {
    status: "done",
    fields: { headline: "t1" },
  });
  await store.createItem("tasks", MILESTONES_AMBIENT_ID, {
    status: "abandoned",
    fields: { headline: "t2" },
  });
  await store.createItem("tasks", MILESTONES_AMBIENT_ID, {
    status: "wip",
    fields: { headline: "t3" },
  });
  await store.createItem("tasks", MILESTONES_AMBIENT_ID, {
    status: "planned",
    fields: { headline: "t4" },
  });

  // defects: resolved, wontfix, open — completedCount=2 (resolved+wontfix),
  // progressTotal=itemCount=3.
  await store.createItem("defects", MILESTONES_AMBIENT_ID, {
    status: "resolved",
    fields: { headline: "d1", severity: "minor" },
  });
  await store.createItem("defects", MILESTONES_AMBIENT_ID, {
    status: "wontfix",
    fields: { headline: "d2", severity: "minor" },
  });
  await store.createItem("defects", MILESTONES_AMBIENT_ID, {
    status: "open",
    fields: { headline: "d3", severity: "minor" },
  });

  await store.dispose();
  return root;
}

/** A capturing CountsIo recording every stdout line. */
function recordingIo(): CountsIo & { outs: string[] } {
  const outs: string[] = [];
  return { outs, out: (l) => outs.push(l), err: () => {} };
}

describe("cq counts — unconditional ledger-summaries emitter (T533)", () => {
  it("emits ledgerSummaries deep-equal to computeLedgerSummaries(store) (== the enumerate_ledgers MCP output) for the same root, exit 0", async () => {
    const root = await seedKnownLedger();

    const io = recordingIo();
    const outcome = await runCounts({ cwd: root }, io);

    // ALWAYS exit 0 — counts never blocks (read-only).
    expect(outcome.exitCode).toBe(0);
    expect(io.outs.length).toBe(1);

    const { store } = await createLedgerStore(root);
    let expected;
    try {
      expected = computeLedgerSummaries(store);
    } finally {
      await store.dispose();
    }

    const parsed = JSON.parse(io.outs[0]!) as typeof expected;

    // Field-for-field: the whole payload, then the per-ledger numbers the
    // task calls out explicitly for questions/tasks/defects.
    expect(parsed).toEqual(expected);
    expect(parsed.ledgers).toEqual(expected.ledgers);
    expect(parsed.counts).toEqual(expected.counts);
    expect(parsed.ledgerSummaries).toEqual(expected.ledgerSummaries);

    for (const name of ["questions", "tasks", "defects"]) {
      const parsedSummary = parsed.ledgerSummaries.find((s) => s.name === name);
      const expectedSummary = expected.ledgerSummaries.find((s) => s.name === name);
      expect(parsedSummary).toBeDefined();
      expect(expectedSummary).toBeDefined();
      expect(parsedSummary!.completedCount).toBe(expectedSummary!.completedCount);
      expect(parsedSummary!.progressTotal).toBe(expectedSummary!.progressTotal);
      expect(parsedSummary!.itemCount).toBe(expectedSummary!.itemCount);
      expect(parsedSummary!.statusCounts).toEqual(expectedSummary!.statusCounts);
    }

    // The known-seed numbers, spelled out explicitly.
    const questions = parsed.ledgerSummaries.find((s) => s.name === "questions")!;
    expect(questions.itemCount).toBe(4);
    expect(questions.completedCount).toBe(2);
    expect(questions.progressTotal).toBe(3);

    const tasks = parsed.ledgerSummaries.find((s) => s.name === "tasks")!;
    expect(tasks.itemCount).toBe(4);
    expect(tasks.completedCount).toBe(2);
    expect(tasks.progressTotal).toBe(4);

    const defects = parsed.ledgerSummaries.find((s) => s.name === "defects")!;
    expect(defects.itemCount).toBe(3);
    expect(defects.completedCount).toBe(2);
    expect(defects.progressTotal).toBe(3);
  });

  it("emits a single-line JSON object with the ledgers/counts/ledgerSummaries shape", async () => {
    const root = await seedKnownLedger();

    const io = recordingIo();
    await runCounts({ cwd: root }, io);

    expect(io.outs.length).toBe(1);
    const parsed: unknown = JSON.parse(io.outs[0]!);
    expect(typeof parsed).toBe("object");
    const rec = parsed as Record<string, unknown>;
    expect(Array.isArray(rec["ledgers"])).toBe(true);
    expect(typeof rec["counts"]).toBe("object");
    expect(Array.isArray(rec["ledgerSummaries"])).toBe(true);
  });
});
