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
        cwd: "/worktrees/task",
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
            text: JSON.stringify({ ...HANDLE, output: { leaked: true } }),
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
        cwd: "/worktrees/task",
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
      parseToml(mcpOverride);
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
        worktreeSelected: plan.argv.includes("/worktrees/task"),
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
        profileConfigParses: true,
        handleOnlyIntercepted: true,
        childDispatchDisabled: true,
      })),
      unknownRoleRejected: true,
      echoedBodyRejected: true,
    });
  });
});
