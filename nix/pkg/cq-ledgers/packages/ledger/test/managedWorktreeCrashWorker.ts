import { promises as fs } from "node:fs";
import {
  releaseManagedWorktree,
  type ManagedWorktreeHandle,
} from "../src/index.js";

interface CrashPayload {
  readonly stateDir: string;
  readonly boundary: string;
  readonly handle: ManagedWorktreeHandle;
  readonly resultCommit: string;
}

const payloadPath = process.argv[2];
if (payloadPath === undefined) throw new Error("managed-worktree crash payload path is required");
const payload = JSON.parse(await fs.readFile(payloadPath, "utf8")) as CrashPayload;

const result = await releaseManagedWorktree(
  {
    handle: payload.handle,
    terminalDisposition: "done",
    resultCommit: payload.resultCommit,
  },
  {
    stateDir: payload.stateDir,
    faultInjector: (boundary) => {
      if (boundary === payload.boundary) process.exit(86);
    },
  },
);

throw new Error(
  `managed-worktree crash boundary ${payload.boundary} was not reached; release returned ${result.status}`,
);
