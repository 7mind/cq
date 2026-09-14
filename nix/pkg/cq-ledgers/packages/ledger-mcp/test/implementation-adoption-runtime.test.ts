import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerToolDecisionForRole } from "@cq/config";
import {
  SqliteLedgerStore,
  FULL_LEDGER_TOOL_PROFILE,
  MAX_READ_LOG_BYTES,
  createInMemoryImplementationEvidenceStore,
  createLedgerMcpTools,
  createManagementLedgerMcpTools,
  nodeGitRunner,
  protectLedgerStoreWithImplementationEvidence,
  type DispatchCapability,
  type RecordImplementationAdoptionInput,
} from "@cq/ledger";
import { publishAdoptionTask } from "../../ledger/test/implementationAdoptionTestSupport.js";
import { createProductionImplementationEvidenceService } from "../src/implementationEvidenceRuntime.js";

test("production operator adoption verifies Git, approval and retained log bytes through the management tool [Behavioral-Active Effectual-GoodCommunication]", async () => {
  const root = await mkdtemp(join(tmpdir(), "cq-adoption-runtime-"));
  const repositoryRoot = join(root, "repository");
  const logsDir = join(root, "logs");
  await mkdir(repositoryRoot);
  await mkdir(join(logsDir, "raw"), { recursive: true });
  const ledger = new SqliteLedgerStore({ dbPath: join(root, "ledger.db"), logsDir });
  const evidence = createInMemoryImplementationEvidenceStore();
  try {
    const run = nodeGitRunner(repositoryRoot);
    const git = async (args: readonly string[]) => {
      const result = await run(args);
      if (result.code !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    await git(["init", "--initial-branch=main"]);
    await writeFile(join(repositoryRoot, "implementation.txt"), "implemented\n");
    await git(["add", "implementation.txt"]);
    const identity = ["-c", "user.name=Adoption Test", "-c", "user.email=adoption@example.invalid"];
    await git([...identity, "commit", "-m", "integrated implementation"]);
    const head = await git(["rev-parse", "HEAD"]);
    const foreign = await git([...identity, "commit-tree", "HEAD^{tree}", "-m", "unintegrated result"]);
    await ledger.init();
    await ledger.createItem("goals", "M-AMBIENT", { id: "G1", status: "clarifying", fields: { title: "adoption", description: "adoption" } });
    const { record } = await publishAdoptionTask(ledger);
    const logContent = "Operator validation: bun run check exited 0 at the exact integration commit.\n";
    const logPath = join(logsDir, record.validation.logPath);
    await writeFile(logPath, logContent);
    const input: RecordImplementationAdoptionInput = {
      taskRef: record.taskRef, expectedTaskUpdatedAt: record.expectedTaskUpdatedAt,
      expectedTaskDigest: record.expectedTaskDigest,
      expectedRepositoryHead: head, resultCommit: head, supersedesCompletionRefs: [],
      approval: record.approval, authorityLossReason: record.authorityLossReason,
      completion: record.completion, validation: { ...record.validation, validatedCommit: head,
        logSha256: createHash("sha256").update(logContent).digest("hex") },
      operationId: record.operationId, author: record.author, session: "D461-runtime",
    };
    const dispatch = { observeEvidence: async () => { throw new Error("operator adoption requested dispatch evidence"); } } as unknown as DispatchCapability;
    const protectedLedger = protectLedgerStoreWithImplementationEvidence(ledger, evidence);
    const service = createProductionImplementationEvidenceService({
      resolved: { store: protectedLedger, implementationEvidenceStore: evidence, configRoot: repositoryRoot, backend: "xdg", branch: "backup" },
      repositoryRoot, dispatchCapability: dispatch, environment: { CQ_HARNESS: "codex" },
    });
    await expect(service.recordAdoption({ ...input, approval: { ...input.approval, answer: "not approved" } })).rejects.toThrow("answered question");
    await expect(service.recordAdoption({ ...input, resultCommit: foreign })).rejects.toThrow("not retained");
    await expect(service.recordAdoption({ ...input, validation: { ...input.validation, logSha256: "f".repeat(64) } })).rejects.toThrow("digest changed");
    await expect(service.recordAdoption({ ...input, validation: { ...input.validation, logPath: "../../outside" } })).rejects.toThrow();
    await writeFile(logPath, "x".repeat(MAX_READ_LOG_BYTES + 1));
    await expect(service.recordAdoption(input)).rejects.toThrow("truncated");
    await writeFile(logPath, logContent);
    await writeFile(join(repositoryRoot, "uncommitted.txt"), "partial work");
    await expect(service.recordAdoption(input)).rejects.toThrow("clean integration worktree");
    await rm(join(repositoryRoot, "uncommitted.txt"));
    expect(Object.keys((await evidence.snapshot()).adoptions)).toEqual([]);
    expect(ledger.fetchItem("tasks", "T1").status).toBe("planned");
    expect(createLedgerMcpTools(protectedLedger).some((tool) => tool.name === "record_implementation_adoption")).toBe(false);
    expect(ledgerToolDecisionForRole("implement-worker", "record_implementation_adoption")).toBe("excluded");
    expect(ledgerToolDecisionForRole("implement-reviewer", "record_implementation_adoption")).toBe("excluded");
    const tool = createManagementLedgerMcpTools(protectedLedger, undefined, undefined, undefined, "", undefined,
      undefined, FULL_LEDGER_TOOL_PROFILE, undefined, service).find((entry) => entry.name === "record_implementation_adoption");
    if (tool === undefined) throw new Error("operator adoption management tool missing");
    const args = { task_ref: input.taskRef, expected_task_updated_at: input.expectedTaskUpdatedAt,
      expected_task_digest: input.expectedTaskDigest,
      expected_repository_head: head, result_commit: head, supersedes_completion_refs: [],
      approval: input.approval, authority_loss_reason: input.authorityLossReason, completion: input.completion,
      validation: input.validation, operation_id: input.operationId, author: input.author, session: input.session };
    const result = await tool.handler(args, null);
    const first = result.content[0];
    if (first === undefined || first.type !== "text") throw new Error("adoption result omitted text");
    const payload = JSON.parse(first.text) as Awaited<ReturnType<typeof service.recordAdoption>>;
    expect(payload).toMatchObject({ status: "recorded", kind: "operator-adoption", taskRef: "tasks:T1", resultCommit: head });
    expect(ledger.fetchItem("tasks", "T1").status).toBe("done");
    expect(ledger.fetch("reviews").milestones.flatMap((group) => group.items)).toHaveLength(1);
    const replay = await tool.handler(args, null);
    const replayText = replay.content[0];
    if (replayText === undefined || replayText.type !== "text") throw new Error("adoption replay omitted text");
    expect(JSON.parse(replayText.text)).toEqual({ ...payload, status: "existing" });
    await expect(protectedLedger.updateItem("tasks", "T1", { fields: { completion: "generic substitution" } })).rejects.toThrow("protected implementation evidence");
  } finally {
    await ledger.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
