/**
 * T1268 — specialized unit coverage for {@link activePlanTaskWaits}, the sole
 * owner of the task-wait status table (T1267 / D192).
 *
 * Production `derivePredicates` already consumes the helper (T1267). This
 * suite locks the status table itself with parameterized dispositions and a
 * structural single-owner guard. Mutation legs (delete exclusion /
 * unconditional exclusion) are exercised in the companion plan-predicates
 * suite and via the deliberate fail-first protocol recorded at commit time.
 */

import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  PLAN_WAITING_TASKS_FIELD,
  type Item,
} from "../src/index.js";
import { activePlanTaskWaits } from "../src/store/predicates.js";

function goalWaiting(refs: readonly string[]): Item {
  return {
    id: "G1",
    milestoneId: "M-AMBIENT",
    status: "planning",
    fields: { [PLAN_WAITING_TASKS_FIELD]: [...refs], title: "g" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function task(id: string, status: string): Item {
  return {
    id,
    milestoneId: "M1",
    status,
    fields: { headline: id },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("T1268 activePlanTaskWaits status table", () => {
  test("empty / missing waitingTasks yields no active waits", () => {
    const bare: Item = {
      id: "G1",
      milestoneId: "M-AMBIENT",
      status: "planning",
      fields: { title: "g" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(activePlanTaskWaits(bare, [task("T1", "planned")])).toEqual([]);
    expect(activePlanTaskWaits(goalWaiting([]), [task("T1", "planned")])).toEqual([]);
  });

  for (const status of ["planned", "wip", "blocked"] as const) {
    test(`keeps the wait active at task status ${status}`, () => {
      const g = goalWaiting(["T1"]);
      expect(activePlanTaskWaits(g, [task("T1", status)])).toEqual(["T1"]);
      // Canonical prefixed form is accepted and stripped to the bare id.
      expect(activePlanTaskWaits(goalWaiting(["tasks:T1"]), [task("T1", status)])).toEqual([
        "T1",
      ]);
    });
  }

  for (const status of ["done", "abandoned"] as const) {
    test(`releases the wait at task status ${status}`, () => {
      expect(activePlanTaskWaits(goalWaiting(["T1"]), [task("T1", status)])).toEqual([]);
    });
  }

  test("releases the wait when the task is missing from the active view", () => {
    expect(activePlanTaskWaits(goalWaiting(["T1"]), [])).toEqual([]);
    expect(activePlanTaskWaits(goalWaiting(["T1"]), [task("T9", "planned")])).toEqual([]);
  });

  test("releases the wait when the task is only present as an archived peer (absent from activeTasks)", () => {
    // derivePredicates / claim only pass ACTIVE tasks; archived is the same
    // observable as missing at this layer.
    expect(activePlanTaskWaits(goalWaiting(["T1"]), [])).toEqual([]);
  });

  test("filters a mixed set down to the still-active bare ids", () => {
    const g = goalWaiting(["T1", "tasks:T2", "T3", "T4"]);
    const active = [
      task("T1", "planned"),
      task("T2", "done"),
      task("T3", "wip"),
      task("T4", "abandoned"),
    ];
    expect(activePlanTaskWaits(g, active)).toEqual(["T1", "T3"]);
  });
});

describe("T1268 structural guard — activePlanTaskWaits is the sole production owner", () => {
  test("the planned/wip/blocked status table lives in exactly one package source", async () => {
    const packagesRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const waitTable: string[] = [];
    const waitOwnerRefs: string[] = [];
    for (const pkg of await readdir(path.join(packagesRoot, "packages"))) {
      const srcRoot = path.join(packagesRoot, "packages", pkg, "src");
      let files: string[];
      try {
        files = await readdir(srcRoot, { recursive: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
        const rel = path.join("packages", pkg, "src", file);
        const text = await readFile(path.join(srcRoot, file), "utf8");
        if (/const activeStatuses = new Set\(\["planned", "wip", "blocked"\]\)/.test(text)) {
          waitTable.push(rel);
        }
        if (text.includes("activePlanTaskWaits")) {
          waitOwnerRefs.push(rel);
        }
      }
    }
    expect(waitTable).toEqual(["packages/ledger/src/store/predicates.ts"]);
    // Production consumers: the helper itself and the lifecycle claim fence.
    expect(waitOwnerRefs.sort()).toEqual([
      "packages/ledger/src/store/inMemoryPlanLifecycle.ts",
      "packages/ledger/src/store/predicates.ts",
    ]);
  });

  test("DerivedPredicates shape is unchanged (still the nine canonical keys)", async () => {
    const text = await readFile(
      fileURLToPath(new URL("../src/store/predicates.ts", import.meta.url)),
      "utf8",
    );
    const match = text.match(/export interface DerivedPredicates \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    const body = match![1]!;
    const keys = [...body.matchAll(/^\s{2}([A-Za-z]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual([
      "pInvestigate",
      "pSeed",
      "pPlan",
      "pResearch",
      "pImplement",
      "openQuestionGate",
      "belowFloor",
      "planBusy",
      "goalDrift",
    ]);
  });
});
