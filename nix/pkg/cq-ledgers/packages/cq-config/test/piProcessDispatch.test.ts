/** G224 / K332: the server-side pi:process launch protocol. */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  PI_DISPATCH_BUILTIN_TOOLS,
  PiChildResultError,
  piChildArgv,
  piChildFinalText,
  piChildResult,
  piDispatchBuiltinTools,
} from "../src/piProcessDispatch.js";

function rolePrompt(roleId: string, disallowed: string): string {
  return ["---", `name: ${roleId}`, "description: fixture", `disallowedTools: ${disallowed}`, "", "---", "", "Body.", ""].join("\n");
}

const PI_ROLE_FRAGMENTS = path.resolve(
  import.meta.dir, "..", "..", "..", "..", "cq-assets", "fragments", "pi", "agents",
);

function event(role: string, texts: readonly string[], type = "message_end"): string {
  return JSON.stringify({ type, message: { role, content: texts.map((text) => ({ type: "text", text })) } });
}

describe("piDispatchBuiltinTools", () => {
  test("a reviewer loses the write tools and dispatch_agent never appears", () => {
    expect(piDispatchBuiltinTools(rolePrompt("implement-reviewer", "write, edit, dispatch_agent"), "implement-reviewer"))
      .toEqual(["read", "grep", "find", "bash"]);
  });

  test("a worker keeps the whole baseline", () => {
    expect(piDispatchBuiltinTools(rolePrompt("implement-worker", "dispatch_agent"), "implement-worker"))
      .toEqual([...PI_DISPATCH_BUILTIN_TOOLS]);
  });

  test("every packaged Pi role's declared policy parses and keeps read", () => {
    for (const roleId of readdirSync(PI_ROLE_FRAGMENTS)) {
      const declaration = readFileSync(path.join(PI_ROLE_FRAGMENTS, roleId, "host-tool-vocabulary.md"), "utf8")
        .split("\n").find((line) => line.startsWith("disallowedTools:"));
      expect(declaration, roleId).toBeDefined();
      expect(
        piDispatchBuiltinTools(rolePrompt(roleId, declaration!.slice("disallowedTools:".length).trim()), roleId),
        roleId,
      ).toContain("read");
    }
  });
});

describe("piChildArgv", () => {
  test("pins provider, model, thinking, a positive tool list and the role prompt file", () => {
    expect(
      piChildArgv({
        piExecutable: "pi",
        token: { harness: "pi", provider: "xai", model: "grok-4.6", effort: "high" },
        tools: ["read", "grep"],
        rolePromptFile: "/tmp/role.md",
        task: "{\"taskId\":\"T1\"}",
      }),
    ).toEqual([
      "pi", "-p", "--mode", "json", "--no-session",
      "--provider", "xai", "--model", "grok-4.6", "--thinking", "high",
      "--tools", "read,grep",
      "--append-system-prompt", "/tmp/role.md",
      "{\"taskId\":\"T1\"}",
    ]);
  });

  test("omits --thinking when the token carries no effort", () => {
    const argv = piChildArgv({
      piExecutable: "pi",
      token: { harness: "pi", provider: "xai", model: "grok-4.6", effort: null },
      tools: ["read"],
      rolePromptFile: "/tmp/role.md",
      task: "{}",
    });
    expect(argv).not.toContain("--thinking");
  });
});

describe("piChildFinalText and piChildResult", () => {
  test("takes the last assistant message's text parts", () => {
    const stdout = [
      event("user", ["task"]),
      event("assistant", ["thinking out loud"]),
      "not json",
      event("assistant", ["done:", "```json\n{\"status\":\"pass\"}\n```"]),
    ].join("\n");
    expect(piChildFinalText(stdout)).toBe("done:\n```json\n{\"status\":\"pass\"}\n```");
    expect(piChildResult(piChildFinalText(stdout))).toEqual({ status: "pass" });
  });

  test("uses the last fenced json block when there are several", () => {
    expect(piChildResult("```json\n{\"a\":1}\n```\nthen\n```json\n{\"a\":2}\n```")).toEqual({ a: 2 });
  });

  test("a final message without a fenced json block is a typed failure", () => {
    expect(() => piChildResult("I could not finish.")).toThrow(PiChildResultError);
  });

  test("a fenced block that is not JSON is a typed failure", () => {
    expect(() => piChildResult("```json\n{not json}\n```")).toThrow(PiChildResultError);
  });
});
