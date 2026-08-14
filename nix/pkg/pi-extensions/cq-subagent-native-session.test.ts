import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  PI_NATIVE_SESSION_SEAM,
  PI_PROCESS_SESSION_SEAM,
  composePiModelArg,
  isPathInsideCwd,
  observePathEscapeCanary,
  runPiNativeSession,
  type PiNativeSessionDependencies,
} from "./cq-subagent-dispatch/cq-subagent-native-session.ts";
import {
  executePiChildDeliveryBranch,
  resolveForceShellout,
  runPiNativeDelivery,
  selectPiChildDeliverySeam,
  setLaunchPiChildForTests,
  setPiNativeSessionDependenciesForTests,
} from "./cq-subagent-dispatch/index.ts";

afterEach(() => {
  setPiNativeSessionDependenciesForTests(null);
  setLaunchPiChildForTests(null);
});

describe("T1699 Pi native session isolation [BA]", () => {
  test("seams are distinct: createAgentSession vs launchPiChild", () => {
    expect(PI_NATIVE_SESSION_SEAM).toBe("createAgentSession");
    expect(PI_PROCESS_SESSION_SEAM).toBe("launchPiChild");
    expect(PI_NATIVE_SESSION_SEAM).not.toBe(PI_PROCESS_SESSION_SEAM);
  });

  test("delivery matrix: same-harness forceShellout=false → native", () => {
    expect(
      selectPiChildDeliverySeam({ activeHarness: "pi", forceShellout: false }),
    ).toBe(PI_NATIVE_SESSION_SEAM);
    expect(
      selectPiChildDeliverySeam({ activeHarness: "pi", forceShellout: true }),
    ).toBe(PI_PROCESS_SESSION_SEAM);
    expect(
      selectPiChildDeliverySeam({ activeHarness: "claude", forceShellout: false }),
    ).toBe(PI_PROCESS_SESSION_SEAM);
  });

  test("resolveForceShellout defaults false and accepts true/1", () => {
    expect(resolveForceShellout({})).toBe(false);
    expect(resolveForceShellout({ CQ_DISPATCH_FORCE_SHELLOUT: "true" })).toBe(true);
    expect(resolveForceShellout({ CQ_DISPATCH_FORCE_SHELLOUT: "1" })).toBe(true);
    expect(resolveForceShellout({ CQ_DISPATCH_FORCE_SHELLOUT: "false" })).toBe(false);
  });

  test("composePiModelArg mirrors process --model provider/model:effort", () => {
    expect(composePiModelArg({ model: "minimax-m3", effort: null })).toBe("minimax-m3");
    expect(composePiModelArg({ model: "minimax-m3", effort: "high" })).toBe("minimax-m3:high");
    expect(composePiModelArg({ model: null, effort: "high" })).toBeNull();
  });

  test("escape canary: relative stays inside; absolute outside detected", () => {
    const cwd = "/tmp/project/.claude/worktrees/pi-native";
    const canary = observePathEscapeCanary({
      cwd,
      relativeTarget: "WIP-T1699.md",
      absoluteOutsideTarget: "/tmp/escape-canary",
    });
    expect(canary.insideWriteOk).toBe(true);
    expect(canary.escaped).toBe(false);
    expect(isPathInsideCwd("../outside", cwd)).toBe(false);
    expect(isPathInsideCwd("/etc/passwd", cwd)).toBe(false);
    expect(isPathInsideCwd("src/index.ts", cwd)).toBe(true);
  });

  test("runPiNativeSession applies model+provider+effort to createAgentSession", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-native-"));
    try {
      writeFileSync(path.join(root, "marker.txt"), "ok");
      let seen: {
        cwd?: string;
        model?: string;
        provider?: string;
        effort?: string;
      } = {};
      const dependencies: PiNativeSessionDependencies = {
        createAgentSession: async (options) => {
          seen = {
            cwd: options.cwd,
            model: options.model,
            provider: options.provider,
            effort: options.effort,
          };
          return {
            session: {
              prompt: async () => {},
              agent: {
                waitForIdle: async () => {},
                state: {
                  messages: [
                    {
                      role: "assistant",
                      content: [{ type: "text", text: "native-ok" }],
                    },
                  ],
                },
              },
            },
          };
        },
        now: () => new Date("2026-08-07T00:00:00.000Z"),
        idFactory: () => "child-fixed",
      };
      const result = await runPiNativeSession(
        {
          cwd: root,
          prompt: "task",
          model: "minimax-m3",
          provider: "ollama-cloud",
          effort: "high",
        },
        dependencies,
      );
      expect(seen.cwd).toBe(root);
      expect(seen.model).toBe("minimax-m3");
      expect(seen.provider).toBe("ollama-cloud");
      expect(seen.effort).toBe("high");
      expect(result.usedCreateAgentSession).toBe(true);
      expect(result.usedLaunchPiChild).toBe(false);
      expect(result.cwd).toBe(root);
      expect(result.finalText).toBe("native-ok");
      expect(result.appliedModel).toBe("minimax-m3");
      expect(result.appliedProvider).toBe("ollama-cloud");
      expect(result.appliedEffort).toBe("high");
      expect(result.childId).toBe("child-fixed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runPiNativeSession refuses non-absolute cwd", async () => {
    await expect(
      runPiNativeSession(
        { cwd: "relative", prompt: "x" },
        {
          createAgentSession: async () => {
            throw new Error("must not create");
          },
        },
      ),
    ).rejects.toThrow(/absolute manager-returned cwd/);
  });

  test("TOPOLOGY SPY: pi→pi forceShellout=false never calls launchPiChild", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-topo-"));
    try {
      let launchCalls = 0;
      setLaunchPiChildForTests(async () => {
        launchCalls += 1;
        throw new Error("launchPiChild must not be called on native path");
      });
      setPiNativeSessionDependenciesForTests({
        createAgentSession: async (options) => ({
          session: {
            prompt: async () => {},
            agent: {
              waitForIdle: async () => {},
              state: {
                messages: [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: `native@${options.cwd}` }],
                  },
                ],
              },
            },
          },
        }),
        idFactory: () => "topo-child",
        now: () => new Date("2026-08-07T00:00:00.000Z"),
      });

      const delivery = await executePiChildDeliveryBranch({
        activeHarness: "pi",
        forceShellout: false,
        native: () =>
          runPiNativeDelivery({
            cwd: root,
            prompt: "topology",
            model: "m",
            provider: "p",
            effort: "low",
          }),
        process: async () => {
          // Would call the launch seam if selected — must not run.
          await (async () => {
            throw new Error("process handler must not run");
          })();
          return null as never;
        },
      });

      expect(delivery.seam).toBe(PI_NATIVE_SESSION_SEAM);
      expect(delivery.result.usedLaunchPiChild).toBe(false);
      expect(delivery.result.usedCreateAgentSession).toBe(true);
      expect(delivery.result.appliedModel).toBe("m");
      expect(delivery.result.appliedEffort).toBe("low");
      expect(launchCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TOPOLOGY SPY: forceShellout=true selects process handler (not native)", async () => {
    let processCalls = 0;
    let nativeCalls = 0;
    const delivery = await executePiChildDeliveryBranch({
      activeHarness: "pi",
      forceShellout: true,
      native: async () => {
        nativeCalls += 1;
        throw new Error("native must not run when forceShellout=true");
      },
      process: async () => {
        processCalls += 1;
        return { ok: true as const };
      },
    });
    expect(delivery.seam).toBe(PI_PROCESS_SESSION_SEAM);
    expect(delivery.result).toEqual({ ok: true });
    expect(processCalls).toBe(1);
    expect(nativeCalls).toBe(0);
  });
});
