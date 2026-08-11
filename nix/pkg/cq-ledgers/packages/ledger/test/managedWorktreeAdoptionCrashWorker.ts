import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  createWorktreeManageCapability,
  FsLedgerStore,
  WORKTREE_MANAGE_TOOL_SPEC,
  type ManagedWorktreeFaultBoundary,
} from "../src/index.js";

interface AdoptionCrashPayload {
  readonly repositoryRoot: string;
  readonly ledgerRoot: string;
  readonly stateDir: string;
  readonly cacheRoot: string;
  readonly worktreePath: string;
  readonly untrackedPath: string;
  readonly baseCommit: string;
  readonly expectedHead: string;
  readonly boundary: ManagedWorktreeFaultBoundary;
}

const payloadPath = process.argv[2];
if (payloadPath === undefined) throw new Error("managed-worktree adoption payload path is required");
const payload = JSON.parse(await fs.readFile(payloadPath, "utf8")) as AdoptionCrashPayload;
const store = new FsLedgerStore({ root: payload.ledgerRoot });
await store.init();

const result = await WORKTREE_MANAGE_TOOL_SPEC.run(
  store,
  createWorktreeManageCapability(payload.repositoryRoot, {
    deps: {
      stateDir: payload.stateDir,
      cacheRoot: payload.cacheRoot,
      bunWorkspaceRoot: payload.repositoryRoot,
      adoptionActivityFence: {
        async observe() {
          const bytes = await fs.readFile(payload.untrackedPath);
          return {
            epoch: "t1207-quiescent",
            contentToken: createHash("sha256").update(bytes).digest("hex"),
            liveDispatches: [],
            liveLeases: [],
            liveProcesses: [],
          };
        },
      },
      install: async () => ({ stdout: "", stderr: "", code: 0 }),
      faultInjector(boundary) {
        if (boundary === payload.boundary) process.exit(86);
      },
    },
  }),
  {
    operation: "prepare",
    taskId: "T1207",
    baseCommit: payload.baseCommit,
    adoptWorktreePath: payload.worktreePath,
    expectedHead: payload.expectedHead,
  },
);

throw new Error(
  `managed-worktree adoption boundary ${payload.boundary} was not reached; prepare returned ${JSON.stringify(result)}`,
);
