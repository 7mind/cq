import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { readOneBoundedNewlineTerminatedRequest } from "../scripts/codex-role-dispatch.js";

describe("Codex role dispatch request framing", () => {
  test("accepts one newline-terminated request before the PTY closes", async () => {
    const input = new PassThrough();
    const request = readOneBoundedNewlineTerminatedRequest(input);

    input.write('{"roleId":"plan-reviewer"}\n');

    await expect(request).resolves.toBe('{"roleId":"plan-reviewer"}');
    expect(input.destroyed).toBeFalse();
  });

  test("rejects EOF before a complete request and bounded oversized input", async () => {
    const incomplete = new PassThrough();
    const incompleteRequest = readOneBoundedNewlineTerminatedRequest(incomplete);
    incomplete.end('{"roleId":"plan-reviewer"}');
    await expect(incompleteRequest).rejects.toThrow("before a newline-terminated JSON value");

    const oversized = new PassThrough();
    const oversizedRequest = readOneBoundedNewlineTerminatedRequest(oversized);
    oversized.write("x".repeat(64 * 1024 + 1));
    await expect(oversizedRequest).rejects.toThrow("request exceeds 65536 bytes before newline");
  });
});
