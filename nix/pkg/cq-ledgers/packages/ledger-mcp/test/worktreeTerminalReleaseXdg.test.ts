/**
 * D336 — terminal release loses its task admission after the task becomes done.
 *
 * Progression-Effectual-GoodCommunication: a production-selected XDG SQLite
 * store, a real Git repository, and a linked MCP client exercise the complete
 * managed-worktree lifecycle without a network dependency.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InMemoryAttestationBackend,
  InMemoryAttestationStore,
  sequentialDispatchRandomBytes,
  serializeWipArtifact,
  type AttestationNamespace,
} from "@cq/config";
import {
  computeManagedGateScriptDagSha256,
  createLedgerStore,
  createWorktreeManageCapability,
  GOALS_LEDGER,
  ImplementationEvidenceService,
  listManagedLiveWorktrees,
  MANAGED_GATE_CLOSURE_MANIFEST,
  MANAGED_GATE_CLOSURE_VERSION,
  MILESTONES_AMBIENT_ID,
  recordProtectedImplementationCompletion,
  TASKS_LEDGER,
  type DispatchCapability,
  type ManagedGateClosureManifestV1,
  type ManagedWorktreeHandle,
  type ImplementationReviewerIdentity,
  type SupervisedWorkerGateRunRequest,
  type SupervisedWorkerGateRunResult,
  type SupervisedWorkerGateRunner,
} from "@cq/ledger";
import { createDispatchCapability } from "../src/dispatchCapability.js";
import { createManagementLedgerMcpServer } from "../src/main.js";
import type { PromptArtifactStore } from "../src/promptArtifactStore.js";

const exec = promisify(execFile);
const roots: string[] = [];
const TASK_ID = "T336";
const GOAL_ID = "G336";
const ARCHIVED_TASK_ID = "T350";
const ARCHIVED_GOAL_ID = "G350";
const GATE_TARGET_PACKAGE = "nix/pkg/cq-ledgers/package.json";
const GATE_TARGET_SCRIPT = "check";
const GATE_TARGET_SCRIPTS = { [GATE_TARGET_SCRIPT]: "bun test" } as const;
const D336_FINALIZED_MANIFEST = "D336 finalized implementation manifest\n";
const D336_MERGE_OPERATION_ID = "d336_merge_v1";
const D336_REVIEWER: ImplementationReviewerIdentity = {
  alias: "d336-native",
  harness: "codex",
  model: "frontier",
  provider: null,
  launch: "native",
  adapterId: "codex:d336-native",
};
const cqCli = fileURLToPath(new URL("../../cq-cli/src/main.ts", import.meta.url));
let dispatchSequence = 0;

interface ReleaseEvidence {
  readonly worktreePresent: boolean;
  readonly branchUnchanged: boolean;
  readonly registryUnchanged: boolean;
}

interface ToolResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

class GreenGateRunner implements SupervisedWorkerGateRunner {
  readonly requests: SupervisedWorkerGateRunRequest[] = [];

  async run(request: SupervisedWorkerGateRunRequest): Promise<SupervisedWorkerGateRunResult> {
    this.requests.push(request);
    return {
      gateExitCode: 0,
      passCount: 17,
      failCount: 0,
      gateDurationMs: 123,
      capturedAt: "2026-08-21T00:00:01.000Z",
      outputTail: "17 pass\n0 fail",
    };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workerArtifactStore(): PromptArtifactStore {
  const metadata = {
    roleId: "implement-worker",
    roleKind: "dispatched-subagent" as const,
    artifactPath: "roles/implement-worker.md",
    sidecarSchemaRoleId: "implement-worker",
    promptSurface: "codex" as const,
    promptDigest: "a".repeat(64),
    schemaVersion: 9,
  };
  return {
    readManifest: () => ({
      bytes: new Uint8Array(),
      roles: [metadata],
      promptSurface: "codex",
      catalogHash: "b".repeat(64),
    }),
    readRole: () => ({ metadata, bytes: new Uint8Array([1]) }),
  };
}

interface ReleaseState {
  readonly worktreePresent: boolean;
  readonly branchCommit: string | null;
  readonly registry: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "D336",
      GIT_AUTHOR_EMAIL: "d336@example.invalid",
      GIT_COMMITTER_NAME: "D336",
      GIT_COMMITTER_EMAIL: "d336@example.invalid",
    },
  });
  return stdout.trim();
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("");
}

function decode<T>(result: ToolResult): T {
  expect(result.isError ?? false, textOf(result)).toBe(false);
  return JSON.parse(textOf(result)) as T;
}

function releaseEvidenceRemains(evidence: ReleaseEvidence): boolean {
  return evidence.worktreePresent && evidence.branchUnchanged && evidence.registryUnchanged;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "d336-worktree-release-"));
  roots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "d336@example.invalid"]);
  await git(root, ["config", "user.name", "D336"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(
    path.join(root, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "d336-${crypto.randomUUID()}"\n`,
  );
  await writeFile(path.join(root, ".gitignore"), ".claude/worktrees/\nnode_modules/\n");
  await writeFile(path.join(root, "README.md"), "D336 seed\n");
  const workspace = path.join(root, path.dirname(GATE_TARGET_PACKAGE));
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify(
      {
        name: "d336-workspace",
        private: true,
        workspaces: [],
        scripts: GATE_TARGET_SCRIPTS,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(workspace, "bun.lock"),
    '{\n  "lockfileVersion": 1,\n  "configVersion": 1,\n  "workspaces": {\n    "": { "name": "d336-workspace", "private": true }\n  }\n}\n',
  );
  const gateClosure: ManagedGateClosureManifestV1 = {
    version: MANAGED_GATE_CLOSURE_VERSION,
    target: {
      packageJson: GATE_TARGET_PACKAGE,
      script: GATE_TARGET_SCRIPT,
      scriptDagSha256: computeManagedGateScriptDagSha256(GATE_TARGET_SCRIPTS, GATE_TARGET_SCRIPT),
    },
    opaqueEdges: [],
  };
  await writeFile(
    path.join(root, MANAGED_GATE_CLOSURE_MANIFEST),
    `${JSON.stringify(gateClosure, null, 2)}\n`,
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "seed"]);
  return root;
}

async function withClient(
  repositoryRoot: string,
  run: (
    client: Client,
    store: Awaited<ReturnType<typeof createLedgerStore>>["store"],
    dispatchCapability: DispatchCapability,
    gateRunner: GreenGateRunner,
    dbPath: string,
  ) => Promise<void>,
): Promise<void> {
  const resolved = await createLedgerStore(repositoryRoot);
  dispatchSequence += 1;
  const namespace: AttestationNamespace = {
    backend: "xdg",
    projectKey: `d336-dispatch-${String(dispatchSequence)}`,
  };
  const gateRunner = new GreenGateRunner();
  const dispatchCapability = createDispatchCapability({
    backend: new InMemoryAttestationBackend(new InMemoryAttestationStore(namespace)),
    promptArtifactStore: workerArtifactStore(),
    repositoryRoot,
    supervisedWorkerGateRunner: gateRunner,
    randomBytes: sequentialDispatchRandomBytes(dispatchSequence * 32),
  });
  if (resolved.implementationEvidenceStore === undefined) {
    throw new Error("D336 XDG fixture did not resolve an implementation evidence store");
  }
  const repositoryBase = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  let reviewResultCommit: string | null = null;
  let reviewAttestation: string | null = null;
  const implementationEvidence = new ImplementationEvidenceService({
    store: resolved.implementationEvidenceStore,
    resolveReviewerRoster: () => [D336_REVIEWER],
    nativeFallback: D336_REVIEWER,
    prepareNativeReview: async ({ attemptRef, panel }) => {
      reviewResultCommit = panel.resultCommit;
      const prepared = {
        attestationId: `att_${attemptRef.slice(-12)}`,
        generation: 1,
        responseStoreNow: "2026-08-21T00:00:03.000Z",
        childCancelAt: "2026-08-21T00:02:03.000Z",
        launchDeadline: "2026-08-21T00:01:03.000Z",
        promptProvenance: {
          roleId: "implement-reviewer",
          version: 7,
          surface: "codex",
          promptDigest: "c".repeat(64),
          catalogHash: "d".repeat(64),
          inputDigest: "e".repeat(64),
        },
        inputCapability: { scope: "fetch-input", token: "d336-review-input" },
        resultCapability: { scope: "store-result", token: "d336-review-result" },
      } as const;
      reviewAttestation = prepared.attestationId;
      return prepared;
    },
    fetchNativeReview: async () => {
      if (reviewResultCommit === null) throw new Error("D336 review was not prepared");
      if (reviewAttestation === null) throw new Error("D336 review attestation was not retained");
      return {
        state: "consumed",
        retainedAttestation: reviewAttestation,
        output: {
          taskId: TASK_ID,
          verdict: "approve",
          criticism: [],
          questions: [],
          defects: [],
          rationale: "D336 protected merge evidence is complete",
          gateReRan: true,
          gateDurationMs: 1,
          resultCommitVerified: true,
          resultCommitEvidence: {
            status: "verified",
            resultCommit: reviewResultCommit,
            branchTip: reviewResultCommit,
          },
          baseAncestry: {
            status: "verified",
            relation: "descendant",
            baseCommit: repositoryBase,
            resultCommit: reviewResultCommit,
            mergeBase: repositoryBase,
          },
        },
      };
    },
    executeExternalReview: async () => {
      throw new Error("D336 uses one native reviewer");
    },
    fetchWorker: async (dispatch) => {
      if (dispatchCapability.observeEvidence === undefined) {
        throw new Error("D336 dispatch evidence observation is unavailable");
      }
      const result = await dispatchCapability.observeEvidence(dispatch);
      return result.state === "consumed"
        ? { state: "consumed", input: result.input, output: result.output }
        : result.state === "aborted"
          ? { state: "aborted" }
          : { state: "missing" };
    },
    readTaskAuthority: async (taskRef) => ({
      taskRef,
      ownerGoalRef: `goals:${GOAL_ID}`,
      status: resolved.store.fetchItem(TASKS_LEDGER, TASK_ID).status,
      finalizedManifest: D336_FINALIZED_MANIFEST,
    }),
    repositoryHead: async () => await git(repositoryRoot, ["rev-parse", "HEAD"]),
    verifyImplementation: async () => ({
      baseCommit: repositoryBase,
      startingCommit: repositoryBase,
      clean: true,
      ancestryVerified: true,
      receiptsVerified: true,
      acceptanceVerified: true,
      gateVerified: true,
      details: { fixture: "D336", ffOnly: true },
    }),
    recordLedgerCompletion: async ({ task, completion, author, session }) =>
      await recordProtectedImplementationCompletion(resolved.store, task, completion, {
        author,
        ...(session === undefined ? {} : { session }),
      }),
  });
  const server = createManagementLedgerMcpServer({
    store: resolved.store,
    displayName: "D336 XDG fixture",
    configRoot: resolved.configRoot,
    ...(resolved.projectKey === undefined ? {} : { projectKey: resolved.projectKey }),
    repositoryRoot,
    dispatchCapability,
    worktreeManage: createWorktreeManageCapability(repositoryRoot, { deps: { skipInstall: true } }),
    implementationEvidence,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "d336-xdg-client", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    expect(resolved.backend).toBe("xdg");
    expect(resolved.dbPath).toContain(process.env["XDG_STATE_HOME"]!);
    if (resolved.dbPath === undefined) {
      throw new Error("D336 XDG fixture did not resolve a database path");
    }
    await run(client, resolved.store, dispatchCapability, gateRunner, resolved.dbPath);
  } finally {
    await client.close();
    await server.close();
    await resolved.store.dispose();
  }
}

function copyActiveTaskToArchive(dbPath: string, pointerId: string, taskId: string): void {
  const db = new Database(dbPath);
  try {
    db.query(
      "INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      TASKS_LEDGER,
      pointerId,
      "duplicate task authority",
      "Duplicate",
      "done",
      new Date().toISOString(),
    );
    db.query(
      `INSERT INTO archived_items
         (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
       SELECT ledger, ?, id, milestone_id, status, fields_json, created_at, updated_at, author, session
       FROM items WHERE ledger = ? AND id = ?`,
    ).run(pointerId, TASKS_LEDGER, taskId);
  } finally {
    db.close();
  }
}

function copyArchivedTaskToArchive(
  dbPath: string,
  sourcePointerId: string,
  pointerId: string,
  taskId: string,
): void {
  const db = new Database(dbPath);
  try {
    db.query(
      "INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      TASKS_LEDGER,
      pointerId,
      "duplicate task authority",
      "Duplicate",
      "done",
      new Date().toISOString(),
    );
    db.query(
      `INSERT INTO archived_items
         (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
       SELECT ledger, ?, id, milestone_id, status, fields_json, created_at, updated_at, author, session
       FROM archived_items WHERE ledger = ? AND pointer_id = ? AND id = ?`,
    ).run(pointerId, TASKS_LEDGER, sourcePointerId, taskId);
  } finally {
    db.close();
  }
}

async function releaseState(
  repositoryRoot: string,
  handle: ManagedWorktreeHandle,
): Promise<ReleaseState> {
  const registryPath = path.join(
    repositoryRoot,
    ".claude",
    "worktrees",
    ".cq-managed-registry",
    "tasks",
    handle.taskId,
    "current.json",
  );
  return {
    worktreePresent: await stat(handle.absolutePath)
      .then((entry) => entry.isDirectory())
      .catch(() => false),
    branchCommit: await git(repositoryRoot, ["rev-parse", `refs/heads/${handle.branch}`]).catch(
      () => null,
    ),
    registry: await readFile(registryPath, "utf8"),
  };
}

async function seedLedger(
  repositoryRoot: string,
  taskId = TASK_ID,
  goalId = GOAL_ID,
): Promise<string> {
  const resolved = await createLedgerStore(repositoryRoot);
  try {
    const milestone = await resolved.store.createMilestone({ title: "D336 terminal release" });
    await resolved.store.createItem(TASKS_LEDGER, milestone.id, {
      id: taskId,
      status: "planned",
      fields: {
        headline: "Release managed D336 task",
        ledgerRefs: [`goals:${goalId}`],
      },
    });
    await resolved.store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: goalId,
      status: "clarifying",
      fields: { title: "D336 restrictive root", description: "keeps the workset nonempty" },
    });
    return milestone.id;
  } finally {
    await resolved.store.dispose();
  }
}

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("D336 production XDG terminal worktree release", () => {
  test("rejects incomplete terminal release evidence", () => {
    expect(
      releaseEvidenceRemains({
        worktreePresent: false,
        branchUnchanged: true,
        registryUnchanged: true,
      }),
    ).toBe(false);
    expect(
      releaseEvidenceRemains({
        worktreePresent: true,
        branchUnchanged: false,
        registryUnchanged: true,
      }),
    ).toBe(false);
    expect(
      releaseEvidenceRemains({
        worktreePresent: true,
        branchUnchanged: true,
        registryUnchanged: false,
      }),
    ).toBe(false);
  });

  test("releases a merged terminal task while restrictive roots remain stable", async () => {
    const previousStateHome = process.env["XDG_STATE_HOME"];
    const stateHome = await mkdtemp(path.join(tmpdir(), "d336-xdg-state-"));
    roots.push(stateHome);
    process.env["XDG_STATE_HOME"] = stateHome;
    try {
      const repositoryRoot = await repository();
      const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      const milestoneId = await seedLedger(repositoryRoot);
      await withClient(repositoryRoot, async (client, store, dispatchCapability, gateRunner) => {
        decode<{ acknowledgement: { roots: string[] } }>(
          (await client.callTool({
            name: "workset",
            arguments: { op: "set", roots: [`milestones:${milestoneId}`, `goals:${GOAL_ID}`] },
          })) as ToolResult,
        );
        const prepared = decode<{ status: string; handle: ManagedWorktreeHandle }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: { operation: "prepare", taskId: TASK_ID, baseCommit },
          })) as ToolResult,
        );
        expect(prepared.status, JSON.stringify(prepared)).toBe("prepared");
        decode(
          (await client.callTool({
            name: "update_item",
            arguments: { ledger_id: "tasks", item_id: TASK_ID, status: "wip" },
          })) as ToolResult,
        );
        const expectedChild = { childId: "child-d336", runId: "run-d336" };
        const dispatch = decode<{
          accepted: true;
          prepared: {
            attestationId: string;
            generation: number;
            inputCapability: { scope: "fetch-input"; token: string };
            resultCapability: { scope: "store-result"; token: string };
            gitChangeCapability: { scope: "git-change"; token: string };
            parentGateCapability: { scope: "parent-gate"; token: string };
            promptProvenance: {
              roleId: string;
              version: number;
              promptDigest: string;
              inputDigest: string;
            };
          };
        }>(
          (await client.callTool({
            name: "prepare_dispatch",
            arguments: {
              roleId: "implement-worker",
              input: {
                taskId: TASK_ID,
                headline: "Release exact D336 result",
                description: "Exercise runner-owned WIP closure through XDG MCP",
                acceptance: "merge and terminal release complete without broadening roots",
                worktreePath: prepared.handle.absolutePath,
                branch: prepared.handle.branch,
                baseCommit,
                round: 0,
                startingCommit: baseCommit,
              },
              idempotencyKey: "d336-terminal-release",
              timeoutMs: 600_000,
              expectedChild,
            },
          })) as ToolResult,
        );
        decode(
          (await client.callTool({
            name: "fetch_dispatch_input",
            arguments: {
              attestationId: dispatch.prepared.attestationId,
              generation: dispatch.prepared.generation,
              inputCapability: dispatch.prepared.inputCapability,
            },
          })) as ToolResult,
        );

        const resultBody = "merged result\n";
        const wipPath = `WIP-${TASK_ID}.md`;
        const wipBody = serializeWipArtifact({
          id: TASK_ID,
          role: "implement-worker",
          baseCommit,
          startedAt: "2026-08-21T00:00:00.000Z",
          checkpoints: [
            {
              name: "trusted full gate",
              status: "unmeasured",
              body: "Awaiting runner-owned evidence.\n",
            },
          ],
          complete: false,
          openCheckpoints: ["trusted full gate"],
        });
        await writeFile(path.join(prepared.handle.absolutePath, "RESULT-T336.md"), resultBody);
        await writeFile(path.join(prepared.handle.absolutePath, wipPath), wipBody);
        const receipt = decode<{
          kind: "cq-git-change-receipt";
          newHead: string;
          paths: string[];
        }>(
          (await client.callTool({
            name: "git_commit",
            arguments: {
              attestationId: dispatch.prepared.attestationId,
              generation: dispatch.prepared.generation,
              gitChangeCapability: dispatch.prepared.gitChangeCapability,
              operationId: "d336-result-v1",
              expectedHead: baseCommit,
              message: "D336 supervised result",
              changes: [
                {
                  kind: "add",
                  path: "RESULT-T336.md",
                  newState: { mode: "100644", digest: sha256(resultBody) },
                },
                {
                  kind: "add",
                  path: wipPath,
                  newState: { mode: "100644", digest: sha256(wipBody) },
                },
              ],
            },
          })) as ToolResult,
        );
        const resultCommit = receipt.newHead;
        const output = {
          taskId: TASK_ID,
          status: "pass",
          resultCommit,
          branch: prepared.handle.branch,
          actualWorktreePath: prepared.handle.absolutePath,
          filesTouched: [...receipt.paths],
          gitReceipts: [receipt],
          checkSummary: "runner-supervised gate requested",
          summary: "D336 exact-tip result",
          baseVerification: {
            status: "verified",
            relation: "descendant",
            baseCommit,
            headCommit: resultCommit,
          },
        };
        expect(
          decode<{ state: string }>(
            (await client.callTool({
              name: "store_result",
              arguments: { resultCapability: dispatch.prepared.resultCapability, output },
            })) as ToolResult,
          ).state,
        ).toBe("gate-pending");
        if (dispatchCapability.finalizeParentGate === undefined) {
          throw new Error("parent gate finalization unavailable");
        }
        expect(
          (
            await dispatchCapability.finalizeParentGate({
              attestationId: dispatch.prepared.attestationId,
              generation: dispatch.prepared.generation,
              parentGateCapability: dispatch.prepared.parentGateCapability,
            })
          ).state,
        ).toBe("result-stored");
        expect(gateRunner.requests).toHaveLength(1);
        decode(
          (await client.callTool({
            name: "confirm_dispatch_completion",
            arguments: {
              attestationId: dispatch.prepared.attestationId,
              generation: dispatch.prepared.generation,
              nativeCompletion: {
                kind: "native-completion",
                actor: "trusted-parent",
                ...expectedChild,
                completedAt: "2026-08-21T00:00:02.000Z",
              },
              expectedProvenance: {
                roleId: dispatch.prepared.promptProvenance.roleId,
                version: dispatch.prepared.promptProvenance.version,
                promptDigest: dispatch.prepared.promptProvenance.promptDigest,
                inputDigest: dispatch.prepared.promptProvenance.inputDigest,
              },
            },
          })) as ToolResult,
        );
        const panel = decode<{
          panelRef: string;
          attemptRefs: string[];
        }>(
          (await client.callTool({
            name: "prepare_implementation_review_panel",
            arguments: {
              task_ref: `tasks:${TASK_ID}`,
              result_commit: resultCommit,
              worker_dispatch: {
                attestationId: dispatch.prepared.attestationId,
                generation: dispatch.prepared.generation,
              },
              operation_id: "d336_review_panel_v1",
              author: "d336-parent",
            },
          })) as ToolResult,
        );
        const attemptRef = panel.attemptRefs[0]!;
        await expect(
          store.updateItem(TASKS_LEDGER, TASK_ID, {
            status: "done",
            fields: { resultCommit, completion: "forged direct completion" },
          }),
        ).rejects.toThrow("protected implementation evidence");
        expect(store.fetchItem(TASKS_LEDGER, TASK_ID).status).toBe("wip");
        expect(
          decode<{ launch: string }>(
            (await client.callTool({
              name: "prepare_implementation_review_attempt",
              arguments: {
                panel_ref: panel.panelRef,
                attempt_ref: attemptRef,
                operation_id: "d336_review_attempt_v1",
                author: "d336-parent",
              },
            })) as ToolResult,
          ).launch,
        ).toBe("native");
        expect(
          decode<{ terminalState: string }>(
            (await client.callTool({
              name: "finalize_implementation_review_attempt",
              arguments: {
                attempt_ref: attemptRef,
                operation_id: "d336_review_finalize_v1",
                author: "d336-parent",
              },
            })) as ToolResult,
          ).terminalState,
        ).toBe("approved");
        const completion = decode<{
          completionRef: string;
          evidenceFingerprint: string;
        }>(
          (await client.callTool({
            name: "prepare_implementation_completion",
            arguments: {
              task_ref: `tasks:${TASK_ID}`,
              expected_repository_head: baseCommit,
              result_commit: resultCommit,
              worker_dispatch: {
                attestationId: dispatch.prepared.attestationId,
                generation: dispatch.prepared.generation,
              },
              review_attempt_refs: [attemptRef],
              completion: "D336 merged terminal result",
              log_paths: [".cq/logs/d336-worker.md", ".cq/logs/d336-reviewer.md"],
              merge_operation_id: D336_MERGE_OPERATION_ID,
              operation_id: "d336_completion_prepare_v1",
              author: "d336-parent",
            },
          })) as ToolResult,
        );
        const merge = await exec(process.execPath, [
          cqCli,
          "gate",
          "git-effect",
          "--operation",
          "merge",
          "--cwd",
          repositoryRoot,
          "--task-id",
          TASK_ID,
          "--commit",
          resultCommit,
          "--completion-ref",
          completion.completionRef,
          "--operation-id",
          D336_MERGE_OPERATION_ID,
        ]);
        const acknowledgement = `CQ_IMPLEMENTATION_COMPLETION_MERGE=${JSON.stringify({
          status: "merged",
          completionRef: completion.completionRef,
          taskRef: `tasks:${TASK_ID}`,
          resultCommit,
          repositoryHead: resultCommit,
          mergeOperationId: D336_MERGE_OPERATION_ID,
          evidenceFingerprint: completion.evidenceFingerprint,
        })}`;
        expect(merge.stdout.toString().trim()).toBe(acknowledgement);

        const recorded = decode<{ status: string; taskRef: string; resultCommit: string }>(
          (await client.callTool({
            name: "record_implementation_completion",
            arguments: {
              task_ref: `tasks:${TASK_ID}`,
              expected_repository_head: resultCommit,
              operation_id: "d336_completion_record_v1",
              author: "d336-parent",
            },
          })) as ToolResult,
        );
        expect(recorded).toMatchObject({
          status: "recorded",
          taskRef: `tasks:${TASK_ID}`,
          resultCommit,
        });
        expect(store.fetchItem(TASKS_LEDGER, TASK_ID).status).toBe("done");

        const rootsBefore = await store.worksetStore!().snapshot();
        await expect(
          store.worksetStore!().admitExternalEffect({
            kind: "worktree-remove",
            targetRef: `tasks:${TASK_ID}`,
          }),
        ).rejects.toMatchObject({ code: "target-excluded" });

        const released = decode<{
          status: string;
          handle: ManagedWorktreeHandle;
          idempotent: boolean;
          absolutePath: string;
        }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: {
              operation: "release",
              handle: prepared.handle,
              terminalDisposition: "done",
              resultCommit,
            },
          })) as ToolResult,
        );
        expect(released).toEqual({
          status: "released",
          handle: prepared.handle,
          idempotent: false,
          absolutePath: prepared.handle.absolutePath,
        });
        expect(
          await stat(prepared.handle.absolutePath)
            .then(() => true)
            .catch(() => false),
        ).toBe(false);
        expect(
          await git(repositoryRoot, ["rev-parse", `refs/heads/${prepared.handle.branch}`]).catch(
            () => null,
          ),
        ).toBeNull();
        expect(
          await git(repositoryRoot, [
            "rev-parse",
            `refs/cq-managed-recovery/${prepared.handle.branch}`,
          ]),
        ).toBe(resultCommit);
        expect(await listManagedLiveWorktrees(repositoryRoot, TASK_ID)).toEqual([]);
        expect(await store.worksetStore!().snapshot()).toEqual(rootsBefore);
      });
    } finally {
      if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previousStateHome;
    }
  });

  test("D350 retains an archived done task worktree when release can no longer read it", async () => {
    const previousStateHome = process.env["XDG_STATE_HOME"];
    const stateHome = await mkdtemp(path.join(tmpdir(), "d350-xdg-archived-state-"));
    roots.push(stateHome);
    process.env["XDG_STATE_HOME"] = stateHome;
    try {
      const repositoryRoot = await repository();
      const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      const milestoneId = await seedLedger(repositoryRoot, ARCHIVED_TASK_ID, ARCHIVED_GOAL_ID);
      await withClient(repositoryRoot, async (client, store) => {
        decode<{ acknowledgement: { roots: string[] } }>(
          (await client.callTool({
            name: "workset",
            arguments: {
              op: "set",
              roots: [
                `milestones:${milestoneId}`,
                `tasks:${ARCHIVED_TASK_ID}`,
                `goals:${ARCHIVED_GOAL_ID}`,
              ],
            },
          })) as ToolResult,
        );
        const prepared = decode<{ status: string; handle: ManagedWorktreeHandle }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: { operation: "prepare", taskId: ARCHIVED_TASK_ID, baseCommit },
          })) as ToolResult,
        );
        expect(prepared.status, JSON.stringify(prepared)).toBe("prepared");

        expect(
          decode<{ item: { status: string } }>(
            (await client.callTool({
              name: "update_item",
              arguments: { ledger_id: TASKS_LEDGER, item_id: ARCHIVED_TASK_ID, status: "done" },
            })) as ToolResult,
          ).item.status,
        ).toBe("done");
        expect(
          decode<{ item: { status: string } }>(
            (await client.callTool({
              name: "update_item",
              arguments: { ledger_id: "milestones", item_id: milestoneId, status: "done" },
            })) as ToolResult,
          ).item.status,
        ).toBe("done");
        expect(
          decode<{ pointer: { id: string; status: string } }>(
            (await client.callTool({
              name: "archive_milestone",
              arguments: { milestone_id: milestoneId, summary: "D350 archived done task" },
            })) as ToolResult,
          ).pointer,
        ).toMatchObject({ id: milestoneId, status: "done" });

        const activeTasks = decode<{ items: readonly { id: string }[] }>(
          (await client.callTool({
            name: "fetch_ledger",
            arguments: { ledger_id: TASKS_LEDGER, projection: "full", offset: 0, limit: 10 },
          })) as ToolResult,
        );
        expect(activeTasks.items.filter((item) => item.id === ARCHIVED_TASK_ID)).toEqual([]);
        const archive = decode<{
          archive: {
            kind: string;
            milestone: { id: string; items: readonly { id: string; status: string }[] };
          };
        }>(
          (await client.callTool({
            name: "fetch_ledger_archive",
            arguments: { ledger_id: TASKS_LEDGER, archive_id: milestoneId },
          })) as ToolResult,
        );
        expect(archive.archive.kind).toBe("group");
        expect(archive.archive.milestone.id).toBe(milestoneId);
        expect(
          archive.archive.milestone.items.filter((item) => item.id === ARCHIVED_TASK_ID),
        ).toEqual([expect.objectContaining({ id: ARCHIVED_TASK_ID, status: "done" })]);

        const rootsBeforeRelease = await store.worksetStore!().snapshot();
        const released = decode<{
          status: string;
          handle: ManagedWorktreeHandle;
          idempotent: boolean;
          absolutePath: string;
        }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: {
              operation: "release",
              handle: prepared.handle,
              terminalDisposition: "done",
            },
          })) as ToolResult,
        );
        expect(released).toEqual({
          status: "released",
          handle: prepared.handle,
          idempotent: false,
          absolutePath: prepared.handle.absolutePath,
        });
        expect(
          await stat(prepared.handle.absolutePath)
            .then(() => true)
            .catch(() => false),
        ).toBe(false);
        expect(
          await git(repositoryRoot, ["rev-parse", `refs/heads/${prepared.handle.branch}`]).catch(
            () => null,
          ),
        ).toBeNull();
        expect(
          await git(repositoryRoot, [
            "rev-parse",
            `refs/cq-managed-recovery/${prepared.handle.branch}`,
          ]),
        ).toBe(baseCommit);
        expect(await listManagedLiveWorktrees(repositoryRoot, ARCHIVED_TASK_ID)).toEqual([]);
        expect(await store.worksetStore!().snapshot()).toEqual(rootsBeforeRelease);

        const repeated = decode<{ status: string; idempotent: boolean }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: {
              operation: "release",
              handle: prepared.handle,
              terminalDisposition: "done",
            },
          })) as ToolResult,
        );
        expect(repeated).toMatchObject({ status: "released", idempotent: true });
      });
    } finally {
      if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previousStateHome;
    }
  });

  test("rejects active plus archived task identity ambiguity before release mutation", async () => {
    const previousStateHome = process.env["XDG_STATE_HOME"];
    const stateHome = await mkdtemp(path.join(tmpdir(), "d350-xdg-active-archive-state-"));
    roots.push(stateHome);
    process.env["XDG_STATE_HOME"] = stateHome;
    try {
      const repositoryRoot = await repository();
      const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      await seedLedger(repositoryRoot, ARCHIVED_TASK_ID, ARCHIVED_GOAL_ID);
      await withClient(repositoryRoot, async (client, store, _dispatch, _gate, dbPath) => {
        const prepared = decode<{ status: string; handle: ManagedWorktreeHandle }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: { operation: "prepare", taskId: ARCHIVED_TASK_ID, baseCommit },
          })) as ToolResult,
        );
        decode(
          (await client.callTool({
            name: "update_item",
            arguments: { ledger_id: TASKS_LEDGER, item_id: ARCHIVED_TASK_ID, status: "done" },
          })) as ToolResult,
        );
        copyActiveTaskToArchive(dbPath, "M350-duplicate", ARCHIVED_TASK_ID);

        const beforeRelease = await releaseState(repositoryRoot, prepared.handle);
        const rootsBeforeRelease = await store.worksetStore!().snapshot();
        const denied = (await client.callTool({
          name: "worktree_manage",
          arguments: {
            operation: "release",
            handle: prepared.handle,
            terminalDisposition: "done",
          },
        })) as ToolResult;
        expect(denied.isError, textOf(denied)).toBe(true);
        expect(textOf(denied)).toContain("resolves to 2 active-or-archived records");
        expect(await releaseState(repositoryRoot, prepared.handle)).toEqual(beforeRelease);
        expect(await store.worksetStore!().snapshot()).toEqual(rootsBeforeRelease);
      });
    } finally {
      if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previousStateHome;
    }
  });

  test("rejects two archived task records before release mutation", async () => {
    const previousStateHome = process.env["XDG_STATE_HOME"];
    const stateHome = await mkdtemp(path.join(tmpdir(), "d350-xdg-two-archive-state-"));
    roots.push(stateHome);
    process.env["XDG_STATE_HOME"] = stateHome;
    try {
      const repositoryRoot = await repository();
      const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      const milestoneId = await seedLedger(repositoryRoot, ARCHIVED_TASK_ID, ARCHIVED_GOAL_ID);
      await withClient(repositoryRoot, async (client, store, _dispatch, _gate, dbPath) => {
        const prepared = decode<{ status: string; handle: ManagedWorktreeHandle }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: { operation: "prepare", taskId: ARCHIVED_TASK_ID, baseCommit },
          })) as ToolResult,
        );
        decode(
          (await client.callTool({
            name: "update_item",
            arguments: { ledger_id: TASKS_LEDGER, item_id: ARCHIVED_TASK_ID, status: "done" },
          })) as ToolResult,
        );
        decode(
          (await client.callTool({
            name: "update_item",
            arguments: { ledger_id: "milestones", item_id: milestoneId, status: "done" },
          })) as ToolResult,
        );
        decode(
          (await client.callTool({
            name: "archive_milestone",
            arguments: { milestone_id: milestoneId, summary: "D350 first archive" },
          })) as ToolResult,
        );
        copyArchivedTaskToArchive(dbPath, milestoneId, "M351-duplicate", ARCHIVED_TASK_ID);

        const beforeRelease = await releaseState(repositoryRoot, prepared.handle);
        const rootsBeforeRelease = await store.worksetStore!().snapshot();
        const denied = (await client.callTool({
          name: "worktree_manage",
          arguments: {
            operation: "release",
            handle: prepared.handle,
            terminalDisposition: "done",
          },
        })) as ToolResult;
        expect(denied.isError, textOf(denied)).toBe(true);
        expect(textOf(denied)).toContain("resolves to 2 active-or-archived records");
        expect(await releaseState(repositoryRoot, prepared.handle)).toEqual(beforeRelease);
        expect(await store.worksetStore!().snapshot()).toEqual(rootsBeforeRelease);
      });
    } finally {
      if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previousStateHome;
    }
  });

  test("denies nonterminal, mismatched, and substituted release bindings without mutation", async () => {
    const previousStateHome = process.env["XDG_STATE_HOME"];
    const stateHome = await mkdtemp(path.join(tmpdir(), "d336-xdg-denial-state-"));
    roots.push(stateHome);
    process.env["XDG_STATE_HOME"] = stateHome;
    try {
      const repositoryRoot = await repository();
      const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      const milestoneId = await seedLedger(repositoryRoot);
      await withClient(repositoryRoot, async (client) => {
        decode(
          (await client.callTool({
            name: "workset",
            arguments: { op: "set", roots: [`milestones:${milestoneId}`, `goals:${GOAL_ID}`] },
          })) as ToolResult,
        );
        const prepared = decode<{ status: string; handle: ManagedWorktreeHandle }>(
          (await client.callTool({
            name: "worktree_manage",
            arguments: { operation: "prepare", taskId: TASK_ID, baseCommit },
          })) as ToolResult,
        );
        expect(prepared.status).toBe("prepared");
        const initial = await releaseState(repositoryRoot, prepared.handle);

        const missing = (await client.callTool({
          name: "worktree_manage",
          arguments: { operation: "prepare", taskId: "T337", baseCommit },
        })) as ToolResult;
        expect(decode<{ status: string; reason: string }>(missing)).toMatchObject({
          status: "refused",
          reason: "dependency-unresolvable",
        });
        expect(await releaseState(repositoryRoot, prepared.handle)).toEqual(initial);

        const nonterminal = (await client.callTool({
          name: "worktree_manage",
          arguments: {
            operation: "release",
            handle: prepared.handle,
            terminalDisposition: "done",
          },
        })) as ToolResult;
        expect(nonterminal.isError, textOf(nonterminal)).toBe(true);
        expect(await releaseState(repositoryRoot, prepared.handle)).toEqual(initial);

        decode(
          (await client.callTool({
            name: "update_item",
            arguments: { ledger_id: "tasks", item_id: TASK_ID, status: "done" },
          })) as ToolResult,
        );

        const substitutedAttempts: readonly {
          readonly handle: ManagedWorktreeHandle;
        }[] = [
          { handle: { ...prepared.handle, token: "substituted-token" } },
          {
            handle: { ...prepared.handle, nonce: "substituted-fingerprint-material" },
          },
          {
            handle: {
              ...prepared.handle,
              repositoryRoot: `${repositoryRoot}-foreign`,
              absolutePath: `${repositoryRoot}-foreign/.claude/worktrees/${prepared.handle.worktreeId}`,
            },
          },
          {
            handle: {
              ...prepared.handle,
              worktreeId: "019f2c7a-6b21-7c44-9e10-7a3f5d9b2e09",
              absolutePath: `${repositoryRoot}/.claude/worktrees/019f2c7a-6b21-7c44-9e10-7a3f5d9b2e09`,
            },
          },
          {
            handle: { ...prepared.handle, taskId: "T337", branch: "implement/T337" },
          },
        ];
        for (const attempt of substitutedAttempts) {
          const denied = (await client.callTool({
            name: "worktree_manage",
            arguments: {
              operation: "release",
              handle: attempt.handle,
              terminalDisposition: "done",
            },
          })) as ToolResult;
          expect(denied.isError, textOf(denied)).toBe(true);
          expect(await releaseState(repositoryRoot, prepared.handle)).toEqual(initial);
        }

        const mismatch = (await client.callTool({
          name: "worktree_manage",
          arguments: {
            operation: "release",
            handle: prepared.handle,
            terminalDisposition: "abandoned",
          },
        })) as ToolResult;
        expect(mismatch.isError, textOf(mismatch)).toBe(true);
        expect(await releaseState(repositoryRoot, prepared.handle)).toEqual(initial);

        const nonCanonical = (await client.callTool({
          name: "worktree_manage",
          arguments: {
            operation: "release",
            handle: prepared.handle,
            terminalDisposition: "done ",
          },
        })) as ToolResult;
        expect(nonCanonical.isError, textOf(nonCanonical)).toBe(true);
        expect(await releaseState(repositoryRoot, prepared.handle)).toEqual(initial);
      });
    } finally {
      if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previousStateHome;
    }
  });
});
