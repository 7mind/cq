import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  createStrictInMemoryWorksetEffectAdmissionProvider,
  readProcessIdentity,
} from "@cq/process-control";
import {
  DISPATCHED_ROLE_IDS,
  DOMAIN_LEDGER_TOOL_NAMES,
  ROLE_TOOL_CAPABILITY_MATRIX,
  createCodexRoleBoundaryPlan,
  executeCodexRoleBoundary,
  interceptCodexRoleBoundaryResult,
  type CodexRoleBoundaryPlan,
} from "@cq/config";

const HANDLE = {
  attestationId: "att_0123456789abcdefghijklmnopqrstuvwxyz",
  generation: 3,
} as const;
const INPUT_CAPABILITY = {
  scope: "fetch-input",
  token: "cq_input_0123456789abcdefghijklmnopqrstuvwxyz",
} as const;
const RESULT_CAPABILITY = {
  scope: "store-result",
  token: "cq_result_0123456789abcdefghijklmnopqrstuvwxyz",
} as const;
const GIT_CHANGE_CAPABILITY = {
  scope: "git-change",
  token: "cq_git_0123456789abcdefghijklmnopqrstuvwxyz",
} as const;
const GIT_CONFLICT_CAPABILITY = {
  scope: "git-conflict",
  token: "cq_conflict_0123456789abcdefghijklmnopqrstuvwxyz",
} as const;
const BOUNDARY_CONTEXTS = {
  cwd: "/worktrees/task",
  ledgerCwd: "/projects/cq",
  resultCapability: RESULT_CAPABILITY,
} as const;
const PLANNING_TOOLS = [
  "fetch_item",
  "fts_search",
  "list_milestone_items",
  "fetch_dispatch_input",
  "store_result",
] as const;
const REVIEW_TOOLS = [
  "fetch_item",
  "fts_search",
  "list_milestone_items",
  "fetch_dispatch_input",
  "store_result",
] as const;
const PLUMBING_TOOLS = ["fetch_dispatch_input", "store_result"] as const;

function trustedStoredStream(finalMessage: string): string {
  const acknowledgement = {
    state: "result-stored",
    result: {
      state: "result-stored",
      ...HANDLE,
      storedAt: "2026-08-13T09:00:00.000Z",
      outputDigest: "sha256:trusted-store-observation",
    },
  } as const;
  return [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "ledger",
        tool: "store_result",
        result: {
          content: [{ type: "text", text: JSON.stringify(acknowledgement) }],
        },
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: finalMessage },
    }),
  ].join("\n");
}

describe("T1330 Codex role process boundary", () => {
  test("delivers the worker Git capability only in the private stdin envelope", () => {
    const plan = createCodexRoleBoundaryPlan({
      roleId: "implement-worker",
      roleInstructions: "implement the task",
      handle: HANDLE,
      inputCapability: INPUT_CAPABILITY,
      gitChangeCapability: GIT_CHANGE_CAPABILITY,
      ...BOUNDARY_CONTEXTS,
      model: "frontier-model",
      reasoningEffort: "high",
      sandboxMode: "workspace-write",
      timeoutMs: 120_000,
      promptRoot: "/nix/store/codex-prompt-root",
      ledgerCommand: "/nix/store/cq/bin/cq",
      codexExecutable: "/nix/store/codex/bin/codex",
    });
    expect(JSON.parse(plan.stdin)).toMatchObject({
      ...HANDLE,
      gitChangeCapability: GIT_CHANGE_CAPABILITY,
    });
    expect(plan.argv.join(" ")).not.toContain(GIT_CHANGE_CAPABILITY.token);
  });

  test("delivers the resolver continuation capability only in the private stdin envelope", () => {
    const plan = createCodexRoleBoundaryPlan({
      roleId: "implement-conflict-resolver",
      roleInstructions: "resolve the conflict",
      handle: HANDLE,
      inputCapability: INPUT_CAPABILITY,
      gitConflictCapability: GIT_CONFLICT_CAPABILITY,
      ...BOUNDARY_CONTEXTS,
      model: "frontier-model",
      reasoningEffort: "high",
      sandboxMode: "workspace-write",
      timeoutMs: 120_000,
      promptRoot: "/nix/store/codex-prompt-root",
      ledgerCommand: "/nix/store/cq/bin/cq",
      codexExecutable: "/nix/store/codex/bin/codex",
    });
    expect(JSON.parse(plan.stdin)).toMatchObject({
      ...HANDLE,
      gitConflictCapability: GIT_CONFLICT_CAPABILITY,
    });
    expect(plan.argv.join(" ")).not.toContain(GIT_CONFLICT_CAPABILITY.token);
  });

  // expected-failure: defects:D343
  test.failing(
    "D343 gives implement-worker result staging and terminal completion distinct bounded windows [Behavioral-Progression Blackbox-Atomic]",
    () => {
      const childWorkTimeoutMs = 120_000;
      const plan = createCodexRoleBoundaryPlan({
        roleId: "implement-worker",
        roleInstructions: "implement the task",
        handle: HANDLE,
        inputCapability: INPUT_CAPABILITY,
        gitChangeCapability: GIT_CHANGE_CAPABILITY,
        ...BOUNDARY_CONTEXTS,
        model: "frontier-model",
        reasoningEffort: "high",
        sandboxMode: "workspace-write",
        timeoutMs: childWorkTimeoutMs,
        promptRoot: "/nix/store/codex-prompt-root",
        ledgerCommand: "/nix/store/cq/bin/cq",
        codexExecutable: "/nix/store/codex/bin/codex",
      });
      const mcpOverride = plan.argv.find((arg) => arg.startsWith("mcp_servers.ledger="));
      if (mcpOverride === undefined) throw new Error("missing ledger MCP override");
      const parsed = parseToml(mcpOverride) as {
        mcp_servers: { ledger: { tool_timeout_sec?: number } };
      };

      expect(parsed.mcp_servers.ledger.tool_timeout_sec).toBe(600);
      expect(plan.timeoutMs).toBe(childWorkTimeoutMs + 900_000);
      expect(plan.effectivePreturn).toMatchObject({
        version: 2,
        childWorkTimeoutMs,
        storeResultSubmissionBudgetMs: 600_000,
        ledgerToolTimeoutSec: 600,
        postStoreSubmissionFinalizationMs: 300_000,
        outerBoundaryTimeoutMs: childWorkTimeoutMs + 900_000,
        parentGateWindowMs: 5_620_000,
      });
    },
  );

  test("faithfully records every dispatched role's pre-context tool profile and launch invariants", () => {
    const domainTools = new Set<string>(DOMAIN_LEDGER_TOOL_NAMES);
    let unknownRoleRejected = false;
    try {
      createCodexRoleBoundaryPlan({
        roleId: "constructor",
        roleInstructions: "must not launch",
        handle: HANDLE,
        inputCapability: INPUT_CAPABILITY,
        ...BOUNDARY_CONTEXTS,
        model: "frontier-model",
        reasoningEffort: "high",
        sandboxMode: "read-only",
        timeoutMs: 120_000,
        promptRoot: "/nix/store/codex-prompt-root",
        ledgerCommand: "/nix/store/cq/bin/cq",
        codexExecutable: "/nix/store/codex/bin/codex",
      });
    } catch {
      unknownRoleRejected = true;
    }
    let echoedBodyRejected = false;
    try {
      interceptCodexRoleBoundaryResult(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              state: "result-stored",
              ...HANDLE,
              outputDigest: "digest-bound-output",
              output: { leaked: true },
            }),
          },
        }),
        HANDLE,
      );
    } catch {
      echoedBodyRejected = true;
    }
    const records = DISPATCHED_ROLE_IDS.map((roleId) => {
      const plan = createCodexRoleBoundaryPlan({
        roleId,
        roleInstructions: `instructions:${roleId}`,
        handle: HANDLE,
        inputCapability: INPUT_CAPABILITY,
        ...BOUNDARY_CONTEXTS,
        model: "frontier-model",
        reasoningEffort: "high",
        sandboxMode: roleId.includes("worker") ? "danger-full-access" : "read-only",
        timeoutMs: 120_000,
        promptRoot: "/nix/store/codex-prompt-root",
        ledgerCommand: "/nix/store/cq/bin/cq",
        codexExecutable: "/nix/store/codex/bin/codex",
      });
      const profile = ROLE_TOOL_CAPABILITY_MATRIX[roleId]!;
      const mcpOverride = plan.argv.find((arg) => arg.startsWith("mcp_servers.ledger="));
      if (mcpOverride === undefined) throw new Error(`${roleId}: missing MCP override`);
      const parsedMcpOverride = parseToml(mcpOverride) as {
        mcp_servers: {
          ledger: {
            default_tools_approval_mode?: string;
          };
        };
      };
      const launch = JSON.parse(plan.stdin) as {
        resultCapability?: typeof RESULT_CAPABILITY;
      };
      const intercepted = interceptCodexRoleBoundaryResult(
        trustedStoredStream(JSON.stringify(HANDLE)),
        HANDLE,
      );
      return {
        roleId,
        tools: plan.ledgerMcp.enabledTools,
        requiredToolsExecutable: profile.contractRequiredTools.every((tool) =>
          plan.ledgerMcp.enabledTools.includes(tool),
        ),
        zeroDomainDefinitions:
          !profile.zeroDomainCalls ||
          plan.ledgerMcp.enabledTools.every((tool) => !domainTools.has(tool)),
        serverProfileArgv: plan.ledgerMcp.args.slice(-2),
        roleInstructionsNative: plan.argv.includes(
          `developer_instructions=${JSON.stringify(`instructions:${roleId}`)}`,
        ),
        modelSelected:
          plan.argv.includes("frontier-model") &&
          plan.argv.includes(`model_reasoning_effort=${JSON.stringify("high")}`),
        worktreeSelected: plan.cwd === "/worktrees/task" && plan.argv.includes("/worktrees/task"),
        ledgerProjectSelected:
          plan.ledgerMcp.args.includes("/projects/cq") &&
          !plan.ledgerMcp.args.includes("/worktrees/task"),
        unattendedMcpApproved:
          parsedMcpOverride.mcp_servers.ledger.default_tools_approval_mode === "approve",
        resultCapabilityDelivered:
          JSON.stringify(launch.resultCapability) === JSON.stringify(RESULT_CAPABILITY),
        launchEnvelopeExact:
          JSON.stringify(Object.keys(launch).sort()) ===
          JSON.stringify(
            ["attestationId", "generation", "inputCapability", "resultCapability"].sort(),
          ),
        capabilitiesAbsentFromArgv:
          !plan.argv.join("\n").includes(INPUT_CAPABILITY.token) &&
          !plan.argv.join("\n").includes(RESULT_CAPABILITY.token),
        ignoresUserConfig: plan.argv.includes("--ignore-user-config"),
        profileConfigParses: true,
        handleOnlyIntercepted:
          plan.interceptStdout &&
          plan.expectedHandle === HANDLE &&
          intercepted.attestationId === HANDLE.attestationId &&
          intercepted.generation === HANDLE.generation,
        childDispatchDisabled:
          plan.argv.includes("features.multi_agent=false") &&
          !plan.ledgerMcp.enabledTools.includes("prepare_dispatch"),
      };
    });

    expect({
      roleIds: records.map(({ roleId }) => roleId),
      tools: Object.fromEntries(records.map(({ roleId, tools }) => [roleId, tools])),
      invariants: records.map(({ roleId, tools: _tools, serverProfileArgv, ...invariants }) => ({
        roleId,
        serverProfileArgv,
        ...invariants,
      })),
      unknownRoleRejected,
      echoedBodyRejected,
    }).toEqual({
      roleIds: [
        "plan-advance",
        "plan-reviewer",
        "implement-worker",
        "implement-reviewer",
        "implement-conflict-resolver",
        "investigate-explorer",
        "investigate-prober",
        "research-explorer",
        "research-experimenter",
      ],
      tools: {
        "plan-advance": PLANNING_TOOLS,
        "plan-reviewer": REVIEW_TOOLS,
        "implement-worker": [...PLUMBING_TOOLS, "git_commit"],
        "implement-reviewer": PLUMBING_TOOLS,
        "implement-conflict-resolver": [...PLUMBING_TOOLS, "git_resolve_continue"],
        "investigate-explorer": PLUMBING_TOOLS,
        "investigate-prober": PLUMBING_TOOLS,
        "research-explorer": PLUMBING_TOOLS,
        "research-experimenter": PLUMBING_TOOLS,
      },
      invariants: DISPATCHED_ROLE_IDS.map((roleId) => ({
        roleId,
        serverProfileArgv: ["--tool-profile", roleId],
        requiredToolsExecutable: true,
        zeroDomainDefinitions: true,
        roleInstructionsNative: true,
        modelSelected: true,
        worktreeSelected: true,
        ledgerProjectSelected: true,
        unattendedMcpApproved: true,
        resultCapabilityDelivered: true,
        launchEnvelopeExact: true,
        capabilitiesAbsentFromArgv: true,
        ignoresUserConfig: true,
        profileConfigParses: true,
        handleOnlyIntercepted: true,
        childDispatchDisabled: true,
      })),
      unknownRoleRejected: true,
      echoedBodyRejected: true,
    });
  });

  test("rejects a relative ledger project directory before launch", () => {
    expect(() =>
      createCodexRoleBoundaryPlan({
        roleId: "implement-worker",
        roleInstructions: "implement the task",
        handle: HANDLE,
        inputCapability: INPUT_CAPABILITY,
        ...BOUNDARY_CONTEXTS,
        ledgerCwd: "relative/project",
        model: "frontier-model",
        reasoningEffort: "high",
        sandboxMode: "workspace-write",
        timeoutMs: 120_000,
        promptRoot: "/nix/store/codex-prompt-root",
        ledgerCommand: "/nix/store/cq/bin/cq",
        codexExecutable: "/nix/store/codex/bin/codex",
      }),
    ).toThrow("ledgerCwd must be absolute");
  });

  test("rejects an empty result capability before launch", () => {
    expect(() =>
      createCodexRoleBoundaryPlan({
        roleId: "implement-worker",
        roleInstructions: "implement the task",
        handle: HANDLE,
        inputCapability: INPUT_CAPABILITY,
        ...BOUNDARY_CONTEXTS,
        resultCapability: { scope: "store-result", token: "" },
        model: "frontier-model",
        reasoningEffort: "high",
        sandboxMode: "workspace-write",
        timeoutMs: 120_000,
        promptRoot: "/nix/store/codex-prompt-root",
        ledgerCommand: "/nix/store/cq/bin/cq",
        codexExecutable: "/nix/store/codex/bin/codex",
      }),
    ).toThrow('resultCapability must contain scope "store-result" and a non-empty token');
  });

  test("T1582 accepts only the exact flat digest-bound result-stored acknowledgement", () => {
    const acknowledgement = {
      state: "result-stored",
      ...HANDLE,
      outputDigest: "digest-bound-output",
    } as const;

    expect(
      interceptCodexRoleBoundaryResult(
        trustedStoredStream(JSON.stringify(acknowledgement)),
        HANDLE,
      ),
    ).toEqual(HANDLE);

    for (const rejected of [
      { state: "result-stored", ...HANDLE },
      { ...acknowledgement, outputDigest: "" },
      { ...acknowledgement, outputDigest: "   " },
      { ...acknowledgement, outputDigest: 7 },
      { ...acknowledgement, outputDigest: null },
      { ...acknowledgement, state: "prepared" },
      { ...acknowledgement, attestationId: "att_wrong" },
      { ...acknowledgement, generation: HANDLE.generation + 1 },
      { ...acknowledgement, output: { leaked: true } },
      { ...acknowledgement, body: { leaked: true } },
    ]) {
      expect(() =>
        interceptCodexRoleBoundaryResult(
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: JSON.stringify(rejected) },
          }),
          HANDLE,
        ),
      ).toThrow("handle-only contract");
    }
  });

  test("D228 projects the exact nested result-stored acknowledgement to the dispatch handle", () => {
    expect(
      interceptCodexRoleBoundaryResult(
        trustedStoredStream(
          JSON.stringify({
            state: "result-stored",
            result: {
              state: "result-stored",
              ...HANDLE,
              storedAt: "2026-07-31T16:55:00.000Z",
              outputDigest: "sha256:d228",
            },
          }),
        ),
        HANDLE,
      ),
    ).toEqual(HANDLE);

    for (const rejected of [
      {
        state: "result-stored",
        result: {
          state: "result-stored",
          ...HANDLE,
          storedAt: "2026-07-31T16:55:00.000Z",
          outputDigest: "sha256:d228",
          output: { leaked: true },
        },
      },
      {
        state: "result-stored",
        result: {
          state: "prepared",
          ...HANDLE,
          storedAt: "2026-07-31T16:55:00.000Z",
          outputDigest: "sha256:d228",
        },
      },
      {
        state: "result-stored",
        result: {
          state: "result-stored",
          ...HANDLE,
          storedAt: "",
          outputDigest: "sha256:d228",
        },
      },
    ]) {
      expect(() =>
        interceptCodexRoleBoundaryResult(
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: JSON.stringify(rejected) },
          }),
          HANDLE,
        ),
      ).toThrow("handle-only contract");
    }
  });

  test("D241 fails closed on a typed invalid-output abort ack with schema diagnostic, not echo", () => {
    const invalidOutputDetails = {
      roleId: "implement-worker",
      version: 1,
      errors: [{ path: "/resultCommit", message: "expected string" }],
      summary: "/resultCommit expected string",
    } as const;
    const nestedAbort = {
      state: "aborted",
      result: {
        state: "aborted",
        ...HANDLE,
        abortedAt: "2026-08-02T19:00:00.000Z",
        reason: "invalid-output",
        details: invalidOutputDetails,
      },
    } as const;
    const flatAbort = {
      state: "aborted",
      ...HANDLE,
      abortedAt: "2026-08-02T19:00:00.000Z",
      reason: "invalid-output",
      details: invalidOutputDetails,
    } as const;

    for (const acknowledgement of [nestedAbort, flatAbort]) {
      let thrown: unknown;
      try {
        interceptCodexRoleBoundaryResult(
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: JSON.stringify(acknowledgement) },
          }),
          HANDLE,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toMatch(/invalid-output/);
      expect(message).toMatch(/\/resultCommit expected string/);
      expect(message).not.toMatch(/handle-only contract \(echo\)/);
    }

    // Non-matching handle still falls through (not treated as our abort).
    expect(() =>
      interceptCodexRoleBoundaryResult(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              ...flatAbort,
              attestationId: "att_wrong",
            }),
          },
        }),
        HANDLE,
      ),
    ).toThrow(/handle-only contract/);
  });

  // Regression D305: a bare child handle used to escape after store_result had aborted.
  test("D305 requires a matching trusted result-stored observation before releasing a handle [BG]", () => {
    const abort = {
      state: "aborted",
      result: {
        state: "aborted",
        ...HANDLE,
        abortedAt: "2026-08-13T09:00:00.000Z",
        reason: "invalid-output",
        details: {
          roleId: "implement-worker",
          version: 8,
          errors: [{ path: "/gitReceipts", message: "expected array" }],
          summary: "/gitReceipts expected array",
        },
      },
    } as const;
    const stream = [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "ledger",
          tool: "store_result",
          result: {
            content: [{ type: "text", text: JSON.stringify(abort) }],
          },
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(HANDLE) },
      }),
    ].join("\n");

    expect(() => interceptCodexRoleBoundaryResult(stream, HANDLE)).toThrow(
      /matching trusted result-stored observation/,
    );
  });

  test("T1536 projects only the exact bare prepared attestation id to its handle", () => {
    expect(
      interceptCodexRoleBoundaryResult(trustedStoredStream(HANDLE.attestationId), HANDLE),
    ).toEqual(HANDLE);

    for (const rejected of [
      "att_wrong",
      ` ${HANDLE.attestationId}`,
      `${HANDLE.attestationId}\n`,
      `${HANDLE.attestationId} surplus`,
      "",
    ]) {
      expect(() =>
        interceptCodexRoleBoundaryResult(
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: rejected },
          }),
          HANDLE,
        ),
      ).toThrow("handle-only contract");
    }
  });

  test("holds Codex replacement through descendant settlement [Behavioral-Active Blackbox Good-Communication]", async () => {
    const root = mkdtempSync(join(tmpdir(), "cq-codex-workset-launch-"));
    const initialized = Bun.spawnSync(["git", "init", "--quiet", root]);
    if (initialized.exitCode !== 0) throw new Error("Codex latch fixture git init failed");
    const marker = join(root, "descendant-pid");
    const release = join(root, "release");
    const capture = join(root, "child-metadata.json");
    const secretAdmission = "codex-secret-admission-t1983";
    const stream = trustedStoredStream(JSON.stringify(HANDLE));
    const script = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      "const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      "descendant.unref();",
      `fs.writeFileSync(${JSON.stringify(marker)},String(descendant.pid));`,
      `fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv,env:process.env}));`,
      `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write(${JSON.stringify(stream)});}},5);`,
    ].join("");
    const plan: CodexRoleBoundaryPlan = {
      roleId: "implement-worker",
      cwd: root,
      sandboxMode: "danger-full-access",
      argv: [process.execPath, "-e", script],
      stdin: "",
      timeoutMs: 30_000,
      expectedHandle: HANDLE,
      ledgerMcp: {
        command: "cq-not-launched",
        args: [],
        env: {},
        enabledTools: [],
        defaultToolsApprovalMode: "approve",
        required: true,
      },
      effectivePreturn: {
        kind: "cq-codex-effective-preturn",
        version: 1,
        roleId: "implement-worker",
        cwd: root,
        ledgerCwd: root,
        handle: HANDLE,
        effectCapabilityScope: null,
        receiptExpectation: null,
        rolePromptDigest: "0".repeat(64),
        enabledTools: [],
        model: "recording",
        reasoningEffort: "medium",
        sandboxMode: "danger-full-access",
        skillsPolicy: "role-instructions",
        multiAgent: false,
      },
      interceptStdout: true,
    };
    const strict = createStrictInMemoryWorksetEffectAdmissionProvider();
    const provider = {
      acquire: async (input: Parameters<typeof strict.acquire>[0]) => ({
        ...(await strict.acquire(input)),
        id: secretAdmission,
      }),
    };
    try {
      const execution = executeCodexRoleBoundary(plan, {
        provider,
        targetRef: "tasks:T1983",
      });
      for (let attempt = 0; !(await Bun.file(marker).exists()); attempt += 1) {
        if (attempt === 999) throw new Error("Codex child did not publish its descendant");
        await Bun.sleep(2);
      }
      const descendantPid = Number.parseInt(await Bun.file(marker).text(), 10);
      let replacementAcknowledged = false;
      const replacement = strict.waitForIdle().then(() => {
        replacementAcknowledged = true;
      });
      await Bun.sleep(25);
      expect(replacementAcknowledged).toBe(false);
      await Bun.write(release, "release");

      expect(await execution).toEqual(HANDLE);
      await replacement;
      expect(await readProcessIdentity(descendantPid)).toBeNull();
      expect(await Bun.file(capture).text()).not.toContain(secretAdmission);
      expect(JSON.stringify(HANDLE)).not.toContain(secretAdmission);
      expect(strict.events()).toEqual([
        "admission-acquired",
        "process-group-registered",
        "guardian-shared",
        "process-group-settled",
        "guardian-released",
        "admission-released",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a replacement refusal prevents the Codex process from being created", async () => {
    const root = mkdtempSync(join(tmpdir(), "cq-codex-workset-refusal-"));
    const marker = join(root, "target-ran");
    const plan: CodexRoleBoundaryPlan = {
      roleId: "implement-worker",
      cwd: root,
      sandboxMode: "danger-full-access",
      argv: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ],
      stdin: "",
      timeoutMs: 30_000,
      expectedHandle: HANDLE,
      ledgerMcp: {
        command: "cq-not-launched",
        args: [],
        env: {},
        enabledTools: [],
        defaultToolsApprovalMode: "approve",
        required: true,
      },
      effectivePreturn: {
        kind: "cq-codex-effective-preturn",
        version: 1,
        roleId: "implement-worker",
        cwd: root,
        ledgerCwd: root,
        handle: HANDLE,
        effectCapabilityScope: null,
        receiptExpectation: null,
        rolePromptDigest: "0".repeat(64),
        enabledTools: [],
        model: "recording",
        reasoningEffort: "medium",
        sandboxMode: "danger-full-access",
        skillsPolicy: "role-instructions",
        multiAgent: false,
      },
      interceptStdout: true,
    };
    try {
      await expect(
        executeCodexRoleBoundary(plan, {
          provider: {
            acquire: async () => {
              throw new Error("replacement committed before Codex admission");
            },
          },
          targetRef: "tasks:T1983",
        }),
      ).rejects.toThrow("replacement committed before Codex admission");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
