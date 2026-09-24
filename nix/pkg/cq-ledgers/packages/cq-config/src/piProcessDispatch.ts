/**
 * G224 / K332 — the server-side `pi:process` launch protocol. It follows the
 * Pi surface's held contract: the child receives its complete typed input as
 * the task and returns one fenced `json` block, and the trusted SERVER plays
 * the parent's part, materializing the input and storing the result. The child
 * therefore needs no ledger tool and never sees a capability; `--tools` is a
 * positive list of Pi built-ins minus the role's attested denials, which also
 * keeps `dispatch_agent` and every ledger tool out of reach.
 */

import { attestedDisallowedTools } from "./claudeRoleToolPolicy.js";
import type { DispatchJSONValue } from "./compactDispatchProtocol.js";
import type { ReviewerToken } from "./types.js";

export const PI_DISPATCH_BUILTIN_TOOLS = Object.freeze(["read", "grep", "find", "bash", "edit", "write"] as const);

const CHILD_MESSAGE_EVENTS: ReadonlySet<string> = new Set(["message_end", "tool_result_end"]);
const FENCED_JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n?```/gu;

export class PiChildResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiChildResultError";
  }
}

export function piDispatchBuiltinTools(rolePrompt: string, roleId: string): readonly string[] {
  const denied = attestedDisallowedTools(rolePrompt, roleId);
  return Object.freeze(PI_DISPATCH_BUILTIN_TOOLS.filter((tool) => !denied.has(tool)));
}

export interface PiChildLaunch {
  readonly piExecutable: string;
  readonly token: ReviewerToken;
  readonly tools: readonly string[];
  readonly rolePromptFile: string;
  readonly task: string;
}

export function piChildArgv(launch: PiChildLaunch): readonly string[] {
  if (launch.token.harness !== "pi" || launch.token.provider === null) {
    throw new Error(`a Pi child needs a pi:<provider>/<model> token, got harness ${launch.token.harness}`);
  }
  return Object.freeze([
    launch.piExecutable, "-p", "--mode", "json", "--no-session",
    "--provider", launch.token.provider, "--model", launch.token.model,
    ...(launch.token.effort === null || launch.token.effort === undefined ? [] : ["--thinking", launch.token.effort]),
    "--tools", launch.tools.join(","),
    "--append-system-prompt", launch.rolePromptFile,
    launch.task,
  ]);
}

interface ChildMessage {
  readonly role?: string;
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
}

/** The last assistant message's text parts, from `pi --mode json` output. */
export function piChildFinalText(stdout: string): string {
  const messages: ChildMessage[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: { readonly type?: string; readonly message?: ChildMessage };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== undefined && CHILD_MESSAGE_EVENTS.has(event.type) && event.message !== undefined) {
      messages.push(event.message);
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const texts = message.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

/** The role result: the last fenced `json` block of the child's final text. */
export function piChildResult(finalText: string): DispatchJSONValue {
  const blocks = [...finalText.matchAll(FENCED_JSON_BLOCK)];
  const last = blocks.at(-1);
  if (last === undefined) {
    throw new PiChildResultError("the Pi child's final message carries no fenced json result");
  }
  try {
    return JSON.parse(last[1]!) as DispatchJSONValue;
  } catch {
    throw new PiChildResultError("the Pi child's fenced json result is not valid JSON");
  }
}
