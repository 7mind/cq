import { describe, expect, test } from "bun:test";
import { parse as parseToml } from "smol-toml";
import {
  DISPATCHED_ROLE_IDS,
  DOMAIN_LEDGER_TOOL_NAMES,
  ROLE_TOOL_CAPABILITY_MATRIX,
  createCodexRoleBoundaryPlan,
  interceptCodexRoleBoundaryResult,
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
  "create_item",
  "fts_search",
  "list_milestone_items",
  "fetch_dispatch_input",
  "store_result",
] as const;
const PLUMBING_TOOLS = ["fetch_dispatch_input", "store_result"] as const;

describe("T1330 Codex role process boundary", () => {
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
        [
          JSON.stringify({ type: "thread.started", thread_id: "child-thread" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify(HANDLE),
            },
          }),
        ].join("\n"),
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
        roleInstructionsNative:
          plan.argv.includes(`developer_instructions=${JSON.stringify(`instructions:${roleId}`)}`),
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
      invariants: records.map(
        ({
          roleId,
          tools: _tools,
          serverProfileArgv,
          ...invariants
        }) => ({
          roleId,
          serverProfileArgv,
          ...invariants,
        }),
      ),
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
        "implement-worker": PLUMBING_TOOLS,
        "implement-reviewer": PLUMBING_TOOLS,
        "implement-conflict-resolver": PLUMBING_TOOLS,
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
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify(acknowledgement),
          },
        }),
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
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              state: "result-stored",
              result: {
                state: "result-stored",
                ...HANDLE,
                storedAt: "2026-07-31T16:55:00.000Z",
                outputDigest: "sha256:d228",
              },
            }),
          },
        }),
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

  test("T1536 projects only the exact bare prepared attestation id to its handle", () => {
    expect(
      interceptCodexRoleBoundaryResult(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: HANDLE.attestationId },
        }),
        HANDLE,
      ),
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
});
