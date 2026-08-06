import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  DISPATCH_OVERLAY_REGISTRY,
  FakeDispatchClock,
  InMemoryAttestationStore,
  abortDispatch,
  codexExpectedChild,
  fetchDispatchResult,
  interceptCodexRoleBoundaryResult,
  prepareDispatch,
  sequentialDispatchRandomBytes,
  storeDispatchResult,
  type AttestationNamespace,
  type CodexRoleBoundaryError,
  type DispatchHandle,
  type DispatchJSONValue,
} from "@cq/config";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const CLI_ENTRY = path.join(PACKAGE_ROOT, "packages", "cq-cli", "src", "main.ts");
const NAMESPACE: AttestationNamespace = { backend: "xdg", projectKey: "t1629-fixture" };
const STARTING_COMMIT = "a".repeat(40);
const RESULT_COMMIT = "b".repeat(40);
const RESULT_BODY_SENTINEL = "RESULT_BODY_MUST_NOT_ESCAPE";
const CAPABILITY_SENTINEL = "RESULT_CAPABILITY_MUST_NOT_ESCAPE";
const FINAL_SENTINEL = "INVALID_FINAL_MUST_NOT_ESCAPE";
const temporaryDirectories: string[] = [];

function matchingStoredEvent(handle: DispatchHandle): string {
  return JSON.stringify({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "ledger",
      tool: "store_result",
      arguments: {
        resultCapability: CAPABILITY_SENTINEL,
        output: RESULT_BODY_SENTINEL,
      },
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              state: "result-stored",
              result: {
                state: "result-stored",
                ...handle,
                storedAt: "2026-08-02T20:00:00.000Z",
                outputDigest: "sha256:fixture",
              },
            }),
          },
        ],
      },
    },
  });
}

function invalidFinalEvent(handle: DispatchHandle): string {
  return JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({ ...handle, narrative: FINAL_SENTINEL }),
    },
  });
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("D250 invalid Codex final after result storage", () => {
  it("logs only bounded evidence, then aborts without materializing the stored body", async () => {
    const clock = new FakeDispatchClock("2026-08-02T20:00:00.000Z");
    const store = new InMemoryAttestationStore(NAMESPACE);
    const deps = { store, now: clock.now };
    const preparedOutcome = prepareDispatch(
      {
        namespace: NAMESPACE,
        roleId: "implement-worker",
        surface: "codex",
        input: {
          taskId: "T1629",
          acceptance: "Invalid finals abort without body materialization.",
          worktreePath: "/tmp/cq-t1629",
          branch: "implement/T1629",
          baseCommit: STARTING_COMMIT,
          round: 1,
          startingCommit: STARTING_COMMIT,
        },
        idempotencyKey: "T1629-round-1",
        timeoutMs: 600_000,
        registry: DISPATCH_OVERLAY_REGISTRY,
        promptDigest: "c".repeat(64),
        catalogHash: "d".repeat(64),
        expectedChild: codexExpectedChild({
          agentType: "implement-worker",
          correlationId: "Zm9vYmFyYmF6cXV1eGNvcnJlbGF0aW9u",
          threadId: "codex-thread-t1629",
        }),
      },
      { store, now: clock.now, randomBytes: sequentialDispatchRandomBytes(29) },
    );
    expect(preparedOutcome.accepted).toBe(true);
    if (!preparedOutcome.accepted) throw new Error(preparedOutcome.detail);
    const prepared = preparedOutcome.prepared;
    const handle = {
      attestationId: prepared.attestationId,
      generation: prepared.generation,
    } as const;
    const stored = storeDispatchResult(
      {
        resultCapability: prepared.resultCapability,
        output: {
          taskId: "T1629",
          status: "pass",
          resultCommit: RESULT_COMMIT,
          branch: "implement/T1629",
          actualWorktreePath: "/tmp/wt-actual",
          filesTouched: ["packages/cq-config/src/dispatchRefAssembly.ts"],
          checkSummary: `REAL_CHECK_EXIT=0 ${RESULT_BODY_SENTINEL}`,
          gateDurationMs: 90_000,
          summary: RESULT_BODY_SENTINEL,
        },
      },
      deps,
    );
    expect(stored.state).toBe("result-stored");

    let boundaryError: CodexRoleBoundaryError | undefined;
    try {
      interceptCodexRoleBoundaryResult(
        [matchingStoredEvent(handle), invalidFinalEvent(handle)].join("\n"),
        handle,
      );
    } catch (error) {
      boundaryError = error as CodexRoleBoundaryError;
    }
    expect(boundaryError?.diagnostic).toMatchObject({
      verdict: "echo",
      detailCode: "surplus-fields",
      matchingResultStoredAcknowledgementPresent: true,
    });

    const root = await mkdtemp(path.join(tmpdir(), "cq-t1629-diagnostic-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
    const diagnosticRecord = JSON.stringify({
      lifecycleState: stored.state,
      diagnostic: boundaryError!.diagnostic,
    });
    const log = Bun.spawn(
      [
        process.execPath,
        "run",
        CLI_ENTRY,
        "log",
        "put",
        "--stdin",
        "--dest",
        "logs/raw/t1629-invalid-output.jsonl",
        "--cwd",
        root,
      ],
      { cwd: PACKAGE_ROOT, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    log.stdin.write(`${diagnosticRecord}\n`);
    log.stdin.end();
    const [logExit, logError] = await Promise.all([
      log.exited,
      new Response(log.stderr).text(),
    ]);
    expect(logExit, logError).toBe(0);
    const persisted = await readFile(
      path.join(root, ".cq", "logs", "raw", "t1629-invalid-output.jsonl"),
      "utf8",
    );
    expect(persisted.trim()).toBe(diagnosticRecord);

    const aborted = abortDispatch(
      {
        namespace: NAMESPACE,
        ...handle,
        actor: "trusted-parent",
        reason: "protocol-violation",
        details: boundaryError!.diagnostic as unknown as DispatchJSONValue,
      },
      deps,
    );
    expect(aborted).toMatchObject({ state: "aborted", reason: "protocol-violation" });
    const observed = fetchDispatchResult(
      { namespace: NAMESPACE, ...handle, actor: "trusted-parent" },
      deps,
    );
    expect(observed).toMatchObject({ state: "aborted", reason: "protocol-violation" });
    const externalized = JSON.stringify({ persisted, aborted, observed });
    for (const sentinel of [RESULT_BODY_SENTINEL, CAPABILITY_SENTINEL, FINAL_SENTINEL]) {
      expect(externalized).not.toContain(sentinel);
    }
  });
});
