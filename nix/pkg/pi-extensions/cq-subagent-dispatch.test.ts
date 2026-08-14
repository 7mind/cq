import { describe, expect, test } from "bun:test";
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

describe("Pi process dispatch workset mediation [Behavioral-Active Blackbox Good-Communication]", () => {
  test("binds one typed target without exposing the provider to the child", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cq-pi-workset-dispatch-"));
    const agentsDir = path.join(root, "cq-agents");
    const previousAgentsDir = process.env.CQ_AGENTS_DIR;
    const previousHarness = process.env.CQ_HARNESS;
    const previousForceShellout = process.env.CQ_DISPATCH_FORCE_SHELLOUT;
    const previousPath = process.env.PATH;
    const provider = createStrictInMemoryWorksetEffectAdmissionProvider();
    const observed: Array<{
      readonly argv: readonly string[];
      readonly env: NodeJS.ProcessEnv;
      readonly effect: PiChildWorksetEffect;
    }> = [];
    let capturedTool: CapturedTool | undefined;

    try {
      mkdirSync(agentsDir);
      const binDir = path.join(root, "bin");
      mkdirSync(binDir);
      const cqCommand = path.join(binDir, "cq");
      writeFileSync(
        cqCommand,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(cqCliSource)} "$@"\n`,
      );
      chmodSync(cqCommand, 0o700);
      writeFileSync(path.join(root, "cq.toml"), '[ledger]\nbackend = "fs"\n');
      writeFileSync(
        path.join(agentsDir, "implement-worker.md"),
        ["---", "name: implement-worker", "---", "Implement the assigned task."].join("\n"),
      );
      writeFileSync(
        path.join(root, "role-tool-profiles.json"),
        JSON.stringify({
          schemaVersion: 1,
          ledgerToolNames: [],
          roles: {
            "implement-worker": { roleTools: [], transportTools: [], excludedTools: [] },
          },
        }),
      );
      process.env.CQ_AGENTS_DIR = agentsDir;
      process.env.CQ_HARNESS = "pi";
      process.env.CQ_DISPATCH_FORCE_SHELLOUT = "1";
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      setLaunchPiChildForTests(async (argv, cwd, env, signal, effect) => {
        observed.push({ argv, env, effect });
        const event = JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "brokered child complete" }],
            provider: "fixture",
            model: "fixture",
          },
        });
        return launchPiChild(
          [process.execPath, "-e", `process.stdout.write(${JSON.stringify(event + "\n")})`],
          cwd,
          env,
          signal,
          effect,
        );
      });
      const api = {
        getActiveTools: (): string[] => [],
        registerTool: (tool: unknown): void => {
          capturedTool = tool as CapturedTool;
        },
      } as unknown as DispatchExtensionApi;
      registerCqSubagentDispatch(api, {
        configDependencies: {
          runCqConfig: async () => JSON.stringify({ configured: false }),
          readConfigFile: () => "",
        },
        worksetEffectAdmissionProvider: provider,
      });
      if (capturedTool === undefined) throw new Error("dispatch_agent was not registered");

      const result = await capturedTool.execute(
        "call-t1983",
        {
          agent: "implement-worker",
          task: "Implement the prepared task.",
          targetRef: "tasks:T1983",
        },
        undefined,
        undefined,
        { cwd: root, model: { id: "fixture", provider: "fixture" } },
      );

      expect(result.content[0]?.text).toBe("brokered child complete");
      expect(observed).toHaveLength(1);
      expect(observed[0]?.effect.targetRef).toBe("tasks:T1983");
      expect(JSON.stringify(observed[0]?.argv)).not.toContain("tasks:T1983");
      expect(JSON.stringify(observed[0]?.env)).not.toContain("tasks:T1983");
      expect(JSON.stringify(result)).not.toContain("tasks:T1983");
      expect(provider.events()).toEqual([
        "admission-acquired",
        "process-group-registered",
        "guardian-shared",
        "process-group-settled",
        "guardian-released",
        "admission-released",
      ]);

      await expect(
        capturedTool.execute(
          "call-invalid-target",
          { agent: "implement-worker", task: "Do not launch.", targetRef: "tasks:not-an-id" },
          undefined,
          undefined,
          { cwd: root, model: { id: "fixture", provider: "fixture" } },
        ),
      ).rejects.toThrow(/canonical tasks\/goals\/defects\/researches targetRef/);
      expect(observed).toHaveLength(1);

      let defaultProviderTool: CapturedTool | undefined;
      const defaultProviderApi = {
        getActiveTools: (): string[] => [],
        registerTool: (tool: unknown): void => {
          defaultProviderTool = tool as CapturedTool;
        },
      } as unknown as DispatchExtensionApi;
      registerCqSubagentDispatch(defaultProviderApi, {
        configDependencies: {
          runCqConfig: async () => JSON.stringify({ configured: false }),
          readConfigFile: () => "",
        },
      });
      if (defaultProviderTool === undefined) throw new Error("default-provider dispatch_agent was not registered");
      const defaultProviderResult = await defaultProviderTool.execute(
        "call-default-provider",
        { agent: "implement-worker", task: "Use the provider sidecar.", targetRef: "tasks:T1983" },
        undefined,
        undefined,
        { cwd: root, model: { id: "fixture", provider: "fixture" } },
      );
      expect(defaultProviderResult.content[0]?.text).toBe("brokered child complete");
      expect(observed).toHaveLength(2);
      expect(observed[1]?.effect.targetRef).toBe("tasks:T1983");
    } finally {
      setLaunchPiChildForTests(null);
      if (previousAgentsDir === undefined) delete process.env.CQ_AGENTS_DIR;
      else process.env.CQ_AGENTS_DIR = previousAgentsDir;
      if (previousHarness === undefined) delete process.env.CQ_HARNESS;
      else process.env.CQ_HARNESS = previousHarness;
      if (previousForceShellout === undefined) delete process.env.CQ_DISPATCH_FORCE_SHELLOUT;
      else process.env.CQ_DISPATCH_FORCE_SHELLOUT = previousForceShellout;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
