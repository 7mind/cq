/** Local XDG reset refuses without modifying state; confirmation policy remains explicit. */

import { describe, it, expect, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createLedgerStore,
  requireWorksetStore,
  readWorksetRootsEpoch,
  LEDGER_STORAGE_DIRNAME,
  type LedgerSchema,
} from "@cq/ledger";
import { dispatch, type ConfirmIo, type DispatchIo } from "../src/main.js";

import { useIsolatedXdgState, writeXdgConfig } from "./xdgFixture.js";

useIsolatedXdgState();
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const opsSchema: LedgerSchema = {
  statusValues: ["open", "done"],
  terminalStatuses: ["done"],
  fields: { headline: { type: "string", required: true } },
};

/** Seed a tmp root with a custom `ops` ledger holding one item. */
async function seedTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "cq-reset-"));
  dirs.push(root);
  await writeXdgConfig(root);
  const { store } = await createLedgerStore(root);
  await store.createLedger("ops", opsSchema);
  await store.createMilestone({ id: "M1", title: "m1" });
  await store.createItem("ops", "M1", { status: "open", fields: { headline: "seeded" } });
  await requireWorksetStore(store).setRoots(["tasks:T-retained"]);
  await store.dispose();
  return root;
}

/** A DispatchIo whose ConfirmIo records output and answers the prompt fixed. */
function recordingIo(isTty: boolean, answer = ""): DispatchIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  const confirm: ConfirmIo = {
    isTty,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    prompt: async () => answer,
  };
  return { outs, errs, out: (l) => outs.push(l), err: (l) => errs.push(l), confirm };
}

/** True iff the tmp root has a custom `ops` ledger (i.e. NOT reset). */
async function hasOpsLedger(root: string): Promise<boolean> {
  const { store: verify } = await createLedgerStore(root);
  try {
    return verify.enumerate().includes("ops");
  } finally {
    await verify.dispose();
  }
}

describe("cq reset [Behavioral-Progression Blackbox-GoodCommunication]", () => {
  const cases = [
    {
      label: "non-TTY requires confirmation",
      isTty: false,
      answer: "",
      args: [],
      exitCode: 2,
      message: "--yes",
    },
    { label: "TTY decline aborts", isTty: true, answer: "n", args: [], exitCode: 1, message: "" },
    {
      label: "TTY acceptance retains unsupported local state",
      isTty: true,
      answer: "y",
      args: [],
      exitCode: 2,
      message: "does not support reset",
    },
    {
      label: "--yes retains unsupported local state",
      isTty: false,
      answer: "",
      args: ["--yes"],
      exitCode: 2,
      message: "does not support reset",
    },
  ];
  for (const scenario of cases) {
    it(scenario.label, async () => {
      const root = await seedTree();
      const config = await fs.readFile(path.join(root, "cq.toml"), "utf8");
      const io = recordingIo(scenario.isTty, scenario.answer);
      const outcome = await dispatch(["reset", "--cwd", root, ...scenario.args], io);
      expect(outcome.exitCode).toBe(scenario.exitCode);
      if (scenario.message !== "") expect(io.errs.join("\n")).toContain(scenario.message);
      expect(await hasOpsLedger(root)).toBe(true);
      expect(await fs.readFile(path.join(root, "cq.toml"), "utf8")).toBe(config);
      await expect(fs.stat(path.join(root, LEDGER_STORAGE_DIRNAME, ".backup"))).rejects.toThrow();
      const { store } = await createLedgerStore(root);
      try {
        expect(await readWorksetRootsEpoch(requireWorksetStore(store))).toEqual({
          roots: ["tasks:T-retained"],
          epoch: 1,
        });
      } finally {
        await store.dispose();
      }
    });
  }
});
