const MAX_ROLE_REQUEST_BYTES = 64 * 1024;

/**
 * Decode one bounded line from the installed role boundary without waiting for
 * a PTY to close. The caller only receives bytes after complete framing.
 */
export async function readOneBoundedNewlineTerminatedRequest(
  input: NodeJS.ReadableStream,
): Promise<string> {
  return await new Promise<string>((resolveRequest, rejectRequest) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
      callback();
    };
    const fail = (message: string): void => settle(() => rejectRequest(new Error(message)));
    const onData = (chunk: Buffer | string): void => {
      const next = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const newline = next.indexOf(0x0a);
      if (newline < 0) {
        if (next.length > MAX_ROLE_REQUEST_BYTES) {
          fail(`codex-role-dispatch: request exceeds ${String(MAX_ROLE_REQUEST_BYTES)} bytes before newline`);
          return;
        }
        buffered = next;
        return;
      }
      if (newline > MAX_ROLE_REQUEST_BYTES) {
        fail(`codex-role-dispatch: request exceeds ${String(MAX_ROLE_REQUEST_BYTES)} bytes before newline`);
        return;
      }
      const line = next.subarray(0, newline);
      if (line.length > 0 && line.at(-1) === 0x0d) {
        fail("codex-role-dispatch: request must use newline, not CRLF framing");
        return;
      }
      settle(() => resolveRequest(line.toString("utf8")));
    };
    const onEnd = (): void => fail("codex-role-dispatch: request ended before a newline-terminated JSON value");
    const onError = (error: Error): void => settle(() => rejectRequest(error));
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}
