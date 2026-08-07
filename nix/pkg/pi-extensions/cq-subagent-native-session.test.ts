import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  PI_NATIVE_SESSION_SEAM,
  PI_PROCESS_SESSION_SEAM,
  isPathInsideCwd,
  observePathEscapeCanary,
  runPiNativeSession,
  type PiNativeSessionDependencies,
} from "./cq-subagent-native-session.ts";
import {
  resolveForceShellout,
  selectPiChildDeliverySeam,
} from "./cq-subagent-dispatch.ts";

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

  test("runPiNativeSession uses createAgentSession({cwd}) and never launchPiChild", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-native-"));
    try {
      writeFileSync(path.join(root, "marker.txt"), "ok");
      let seenCwd: string | null = null;
      const dependencies: PiNativeSessionDependencies = {
        createAgentSession: async (options) => {
          seenCwd = options.cwd;
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
        { cwd: root, prompt: "task" },
        dependencies,
      );
      expect(seenCwd).toBe(root);
      expect(result.usedCreateAgentSession).toBe(true);
      expect(result.usedLaunchPiChild).toBe(false);
      expect(result.cwd).toBe(root);
      expect(result.finalText).toBe("native-ok");
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
});
