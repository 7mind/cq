/**
 * D399 — the Pi extension never completes the ref-first lifecycle.
 *
 * The packaged Pi PARENT contract (fragments/pi/subagent-dispatch.md) says the
 * parent calls `prepare_dispatch` and then launches
 * `dispatch_agent(agent, task: "<dispatch-handle>", targetRef)`, where `task`
 * carries the OPAQUE handle and nothing else. The extension is supposed to
 * resolve the prepare-bound typed input, inject it at the child boundary, and
 * store the child's structured result against the prepared result capability.
 *
 * It does none of that: `args.task` is forwarded to the child verbatim as its
 * prompt, and the child's final text is returned as the tool body. A prepared
 * attestation therefore stays prepared and is truthfully aborted missing-result
 * — which is what happened to att_SCZmv73EK4sACsg4HVQy4itOcJPT6Juv and
 * att_47N5ElOspr_-0A-Fp1NHn-BNoDbpMpOQ on goals:G183.
 *
 * This suite reproduces that before any fix. It asserts only what the parent
 * contract already promises, so it does not presuppose how the capability
 * reaches the extension.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createStrictInMemoryWorksetEffectAdmissionProvider } from "@cq/process-control";
import {
  registerCqSubagentDispatch,
  setLaunchPiChildForTests,
  type DispatchDetails,
} from "./cq-subagent-dispatch/index.ts";
import {
  launchPiChild,
  type PiChildWorksetEffect,
} from "./cq-subagent-dispatch/cq-subagent-process-lifecycle.ts";

type DispatchExtensionApi = Parameters<typeof registerCqSubagentDispatch>[0];

const cqCliSource = fileURLToPath(
  new URL("../cq-ledgers/packages/cq-cli/src/main.ts", import.meta.url),
);

/** The opaque handle shape the parent contract says `task` carries. */
const DISPATCH_HANDLE = "att_D399ReproHandle000000000000000000000000";

interface CapturedTool {
  execute: (
    toolCallId: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: Readonly<Record<string, unknown>>,
  ) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: DispatchDetails;
  }>;
}

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "CQ_AGENTS_DIR",
  "CQ_HARNESS",
  "CQ_DISPATCH_FORCE_SHELLOUT",
  "PATH",
  "XDG_STATE_HOME",
] as const;
let root: string | undefined;

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setLaunchPiChildForTests(undefined);
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("D399 Pi extension ref-first lifecycle [Behavioral-Active Blackbox]", () => {
  // This test FAILS on purpose and stays failing until D399 is fixed. It is
  // not reached by `bun run check` (the workspace root is nix/pkg/cq-ledgers),
  // so the green gate asserts its failure as a subprocess instead — §6a form
  // (b), in packages/cq-config/test/piSubagentRefFirstDispatch.test.ts.
  test("resolves the dispatch handle instead of handing it to the child as a prompt", async () => {
    root = mkdtempSync(path.join(tmpdir(), "cq-d399-"));
    const agentsDir = path.join(root, "cq-agents");
    mkdirSync(agentsDir);
    const binDir = path.join(root, "bin");
    mkdirSync(binDir);
    const cqCommand = path.join(binDir, "cq");
    writeFileSync(
      cqCommand,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(cqCliSource)} "$@"\n`,
    );
    chmodSync(cqCommand, 0o700);
    writeFileSync(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nprojectId = "d399-pi-ref-first"\n',
    );
    writeFileSync(
      path.join(agentsDir, "plan-advance.md"),
      ["---", "name: plan-advance", "---", "Produce a candidate DAG."].join("\n"),
    );
    writeFileSync(
      path.join(root, "role-tool-profiles.json"),
      JSON.stringify({
        schemaVersion: 1,
        ledgerToolNames: [],
        roles: { "plan-advance": { roleTools: [], transportTools: [], excludedTools: [] } },
      }),
    );
    process.env.XDG_STATE_HOME = path.join(root, "xdg-state");
    process.env.CQ_AGENTS_DIR = agentsDir;
    process.env.CQ_HARNESS = "pi";
    process.env.CQ_DISPATCH_FORCE_SHELLOUT = "1";
    process.env.PATH = `${binDir}:${saved["PATH"] ?? ""}`;

    const observed: { readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv }[] = [];
    setLaunchPiChildForTests(
      async (
        argv: readonly string[],
        cwd: string,
        env: NodeJS.ProcessEnv,
        signal: AbortSignal | undefined,
        effect: PiChildWorksetEffect,
      ) => {
        observed.push({ argv, env });
        // A schema-valid candidate body, exactly what Sol and Grok returned.
        const event = JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: '```json\n{"kind":"candidate"}\n```' }],
            provider: "fixture",
            model: "fixture",
          },
        });
        return launchPiChild(
          [process.execPath, "-e", `process.stdout.write(${JSON.stringify(`${event}\n`)})`],
          cwd,
          env,
          signal,
          effect,
        );
      },
    );

    let captured: CapturedTool | undefined;
    registerCqSubagentDispatch(
      {
        getActiveTools: (): string[] => [],
        registerTool: (tool: unknown): void => {
          captured = tool as CapturedTool;
        },
      } as unknown as DispatchExtensionApi,
      {
        configDependencies: {
          runCqConfig: async () => JSON.stringify({ configured: false }),
          readConfigFile: () => "",
        },
        worksetEffectAdmissionProvider: createStrictInMemoryWorksetEffectAdmissionProvider(),
      },
    );
    if (captured === undefined) throw new Error("dispatch_agent was not registered");

    const result = await captured.execute(
      "call-d399",
      { agent: "plan-advance", task: DISPATCH_HANDLE, targetRef: "goals:G183" },
      undefined,
      undefined,
      { cwd: root, model: { id: "fixture", provider: "fixture" } },
    );

    expect(observed).toHaveLength(1);
    // The handle is a REFERENCE the extension must resolve. Handing it to the
    // child as its prompt means the child is asked to act on an opaque token.
    expect(JSON.stringify(observed[0]?.argv)).not.toContain(DISPATCH_HANDLE);
    // And the body must not come back as the tool's answer: the ref-first
    // lifecycle materializes a result exactly once through fetch_dispatch_result.
    expect(result.content[0]?.text ?? "").not.toContain('"kind":"candidate"');
  }, 60_000);
});
