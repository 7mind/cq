import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  CODEX_ROLE_BOUNDARY_DIAGNOSTIC_PREFIX,
  CodexRoleBoundaryError,
  formatCodexRoleBoundaryDiagnostic,
  interceptCodexRoleBoundaryResult,
  type CodexRoleBoundaryDiagnostic,
} from "@cq/config";

const HANDLE = {
  attestationId: "att_0123456789abcdefghijklmnopqrstuvwxyz",
  generation: 3,
} as const;
const FINAL_NARRATIVE_SENTINEL = "FINAL_NARRATIVE_SENTINEL";
const RESULT_BODY_SENTINEL = "RESULT_BODY_SENTINEL";
const CAPABILITY_SENTINEL = "CAPABILITY_SENTINEL";
const STREAM_CONTENT_SENTINEL = "STREAM_CONTENT_SENTINEL";
const MALFORMED_JSONL_SENTINEL = "MALFORMED_JSONL_STREAM_SENTINEL";

function completedAgentMessage(text: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text },
  });
}

function storedResultToolEvent(): string {
  return JSON.stringify({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "ledger",
      tool: "store_result",
      arguments: {
        output: RESULT_BODY_SENTINEL,
        resultCapability: CAPABILITY_SENTINEL,
      },
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              state: "result-stored",
              result: {
                state: "result-stored",
                ...HANDLE,
                storedAt: "2026-08-02T19:00:00.000Z",
                outputDigest: "sha256:stored-result",
              },
            }),
          },
        ],
        structured_content: null,
      },
      error: null,
      status: "completed",
    },
  });
}

function captureBoundaryError(jsonl: string): CodexRoleBoundaryError {
  try {
    interceptCodexRoleBoundaryResult(jsonl, HANDLE);
  } catch (error) {
    expect(error).toBeInstanceOf(CodexRoleBoundaryError);
    return error as CodexRoleBoundaryError;
  }
  throw new Error("expected Codex role boundary rejection");
}

function expectNoBoundaryContent(value: unknown): void {
  const rendered = JSON.stringify(value);
  for (const sentinel of [
    FINAL_NARRATIVE_SENTINEL,
    RESULT_BODY_SENTINEL,
    CAPABILITY_SENTINEL,
    STREAM_CONTENT_SENTINEL,
    MALFORMED_JSONL_SENTINEL,
    HANDLE.attestationId,
    "att_wrong",
  ]) {
    expect(rendered).not.toContain(sentinel);
  }
}

describe("T1628 Codex boundary diagnostics", () => {
  test("retains a typed bounded diagnostic without retaining boundary content", () => {
    const finalMessage = FINAL_NARRATIVE_SENTINEL;
    const jsonl = [
      MALFORMED_JSONL_SENTINEL,
      completedAgentMessage(finalMessage),
    ].join("\n");

    const observed = captureBoundaryError(jsonl);
    expect(observed).toMatchObject({
      diagnostic: {
        version: 1,
        verdict: "unparseable",
        detailCode: "invalid-json",
        finalMessageByteLength: Buffer.byteLength(finalMessage),
        finalMessageSha256: createHash("sha256").update(finalMessage).digest("hex"),
        completedAgentMessageCount: 1,
        malformedJsonlCount: 1,
        matchingResultStoredAcknowledgementPresent: false,
      },
    });
    expectNoBoundaryContent(observed);
  });

  test("records a matching stored acknowledgement before an unsupported final", () => {
    const unsupportedFinal = JSON.stringify({
      ...HANDLE,
      narrative: FINAL_NARRATIVE_SENTINEL,
      output: RESULT_BODY_SENTINEL,
      capability: CAPABILITY_SENTINEL,
      stream: STREAM_CONTENT_SENTINEL,
    });
    const observed = captureBoundaryError(
      [
        MALFORMED_JSONL_SENTINEL,
        completedAgentMessage("intermediate message"),
        storedResultToolEvent(),
        completedAgentMessage(unsupportedFinal),
      ].join("\n"),
    );

    expect(observed.diagnostic).toEqual({
      version: 1,
      verdict: "echo",
      detailCode: "surplus-fields",
      finalMessageByteLength: Buffer.byteLength(unsupportedFinal),
      finalMessageSha256: createHash("sha256").update(unsupportedFinal).digest("hex"),
      completedAgentMessageCount: 2,
      malformedJsonlCount: 1,
      matchingResultStoredAcknowledgementPresent: true,
    });
    expectNoBoundaryContent(observed);
  });

  test("reduces wrong handles and missing messages to closed codes", () => {
    const wrongHandle = JSON.stringify({ attestationId: "att_wrong", generation: 19 });
    const wrong = captureBoundaryError(completedAgentMessage(wrongHandle));
    expect(wrong.diagnostic).toMatchObject({
      verdict: "wrong-handle",
      detailCode: "mismatched-handle",
      completedAgentMessageCount: 1,
      malformedJsonlCount: 0,
      matchingResultStoredAcknowledgementPresent: false,
    });
    expectNoBoundaryContent(wrong);

    const missing = captureBoundaryError(MALFORMED_JSONL_SENTINEL);
    expect(missing.diagnostic).toEqual({
      version: 1,
      verdict: "no-completed-message",
      detailCode: "no-completed-agent-message",
      finalMessageByteLength: 0,
      finalMessageSha256: createHash("sha256").update("").digest("hex"),
      completedAgentMessageCount: 0,
      malformedJsonlCount: 1,
      matchingResultStoredAcknowledgementPresent: false,
    });
    expectNoBoundaryContent(missing);
  });

  test("counts syntactically valid non-event JSON without escaping a raw TypeError", () => {
    const observed = captureBoundaryError(
      ["null", completedAgentMessage(FINAL_NARRATIVE_SENTINEL)].join("\n"),
    );
    expect(observed.diagnostic).toMatchObject({
      verdict: "unparseable",
      detailCode: "invalid-json",
      completedAgentMessageCount: 1,
      malformedJsonlCount: 1,
      matchingResultStoredAcknowledgementPresent: false,
    });
    expectNoBoundaryContent(observed);
  });

  test("preserves the valid one-line handle contract without a diagnostic", () => {
    expect(
      interceptCodexRoleBoundaryResult(
        [storedResultToolEvent(), completedAgentMessage(HANDLE.attestationId)].join("\n"),
        HANDLE,
      ),
    ).toEqual(HANDLE);
  });

  // expected-failure: tasks:T2144
  test.failing(
    "D340 classifies brokered store_result omission, rejection, and typed abort at the parent boundary [Behavioral-Progression Blackbox-Atomic]",
    () => {
      const typedAbort = JSON.stringify({
        state: "aborted",
        result: {
          state: "aborted",
          ...HANDLE,
          abortedAt: "2026-08-16T22:00:00.000Z",
          reason: "invalid-output",
          details: { summary: "/resultCommit expected string" },
        },
      });
      const rejectedStoreResult = JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "ledger",
          tool: "store_result",
          result: null,
          error: { message: "storage rejected" },
          status: "failed",
        },
      });
      const observations = Object.fromEntries(
        [
          ["omitted", completedAgentMessage(HANDLE.attestationId)],
          [
            "rejected",
            [rejectedStoreResult, completedAgentMessage(HANDLE.attestationId)].join("\n"),
          ],
          ["typed-abort", completedAgentMessage(typedAbort)],
        ].map(([outcome, stream]) => {
          if (outcome === undefined || stream === undefined) {
            throw new Error("D340 outcome fixture is incomplete");
          }
          let message = "";
          try {
            interceptCodexRoleBoundaryResult(stream, HANDLE);
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          return [outcome, message];
        }),
      );

      // These controls deliberately remain outside the D340 outcome matrix.
      expect(
        captureBoundaryError(
          `${MALFORMED_JSONL_SENTINEL}\n${completedAgentMessage("null")}`,
        ).diagnostic,
      ).toMatchObject({ verdict: "unparseable", detailCode: "invalid-shape" });
      expect(() => interceptCodexRoleBoundaryResult(completedAgentMessage("setup failed"), HANDLE))
        .toThrow("handle-only contract");
      expect(() => interceptCodexRoleBoundaryResult(completedAgentMessage("timeout"), HANDLE))
        .toThrow("handle-only contract");
      expect(() =>
        interceptCodexRoleBoundaryResult(
          completedAgentMessage(
            JSON.stringify({
              state: "aborted",
              ...HANDLE,
              abortedAt: "2026-08-16T22:00:00.000Z",
              reason: "invalid-output",
              details: { summary: "/unrelated expected string" },
            }),
          ),
          HANDLE,
        ),
      ).toThrow("/unrelated expected string");

      expect(observations).toEqual({
        omitted: "D340 brokered store_result outcome: omitted",
        rejected: "D340 brokered store_result outcome: rejected",
        "typed-abort": "D340 brokered store_result outcome: typed-abort",
      });
    },
  );

  test("formats exactly one canonical machine-readable diagnostic line", () => {
    const observed = captureBoundaryError(
      [MALFORMED_JSONL_SENTINEL, completedAgentMessage(FINAL_NARRATIVE_SENTINEL)].join("\n"),
    );
    const line = formatCodexRoleBoundaryDiagnostic(observed.diagnostic!);
    expect(line.startsWith(CODEX_ROLE_BOUNDARY_DIAGNOSTIC_PREFIX)).toBe(true);
    const diagnostic = JSON.parse(
      line.slice(CODEX_ROLE_BOUNDARY_DIAGNOSTIC_PREFIX.length),
    ) as CodexRoleBoundaryDiagnostic;
    expect(Object.keys(diagnostic)).toEqual([
      "version",
      "verdict",
      "detailCode",
      "finalMessageByteLength",
      "finalMessageSha256",
      "completedAgentMessageCount",
      "malformedJsonlCount",
      "matchingResultStoredAcknowledgementPresent",
    ]);
    expect(diagnostic).toMatchObject({
      version: 1,
      verdict: "unparseable",
      detailCode: "invalid-json",
      completedAgentMessageCount: 1,
      malformedJsonlCount: 1,
      matchingResultStoredAcknowledgementPresent: false,
    });
    expect(line).not.toContain(FINAL_NARRATIVE_SENTINEL);
    expect(line).not.toContain(CAPABILITY_SENTINEL);
    expect(line).not.toContain(HANDLE.attestationId);
  });
});
