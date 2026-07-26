/**
 * Unit tests for the `logRedaction` module.
 *
 * Coverage:
 *  - Each pattern in `REDACTION_KINDS` is replaced with `[REDACTED:<kind>]`.
 *  - Non-secret text is left untouched.
 *  - The function is idempotent: redactSecrets(redactSecrets(x)) === redactSecrets(x).
 *  - Multiple occurrences of distinct patterns in one string are all replaced.
 */

import { describe, it, expect } from "bun:test";
import { redactSecrets, REDACTION_KINDS } from "../src/store/logRedaction.js";

describe("redactSecrets", () => {
  // -------------------------------------------------------------------------
  // Per-kind pattern tests (iterated over REDACTION_KINDS for completeness)
  // -------------------------------------------------------------------------

  it("covers every kind in REDACTION_KINDS taxonomy", () => {
    // Confirm every kind has at least one test below by exercising a sample
    // string for each kind.  This assertion ensures the taxonomy tuple and the
    // test cases stay in sync.
    const covered = new Set<string>();

    const cases: Array<{ kind: string; input: string }> = [
      { kind: "aws-key", input: "key=AKIAIOSFODNN7EXAMPLE" },
      { kind: "github-token", input: "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" },
      { kind: "api-key", input: "Authorization: sk-abcdefghijklmnopqrstuvwxyz012345" },
      { kind: "bearer", input: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" },
      { kind: "slack-token", input: "token=xoxb-1234567890-abcdefghij" },
      {
        kind: "plan-owner-fence-token",
        input: '{"ownerFenceToken":"tZ3n5Qw8Lp2Rk9Vb4Xc7Ym"}',
      },
    ];

    for (const { kind, input } of cases) {
      const result = redactSecrets(input);
      expect(result).toContain(`[REDACTED:${kind}]`);
      covered.add(kind);
    }

    for (const kind of REDACTION_KINDS) {
      expect(covered.has(kind)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // aws-key
  // -------------------------------------------------------------------------

  it("redacts an AWS access key ID", () => {
    const input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    expect(redactSecrets(input)).toBe("AWS_ACCESS_KEY_ID=[REDACTED:aws-key]");
  });

  it("redacts multiple AWS key IDs in one string", () => {
    const input = "key1=AKIAIOSFODNN7EXAMPLE key2=AKIAI44QH8DHBEXAMPLE";
    const result = redactSecrets(input);
    expect(result).toBe("key1=[REDACTED:aws-key] key2=[REDACTED:aws-key]");
  });

  it("does not redact AKIA prefix shorter than 16 trailing chars", () => {
    // Only 15 trailing chars after AKIA — must NOT match.
    const input = "AKIAIOSFODNN7EXAMPL";
    expect(redactSecrets(input)).toBe(input);
  });

  // -------------------------------------------------------------------------
  // github-token
  // -------------------------------------------------------------------------

  it("redacts a GitHub personal access token (ghp_)", () => {
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    expect(redactSecrets(`token=${token}`)).toBe("token=[REDACTED:github-token]");
  });

  it("redacts GitHub OAuth token (gho_)", () => {
    const token = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    expect(redactSecrets(token)).toBe("[REDACTED:github-token]");
  });

  it("redacts GitHub user-to-server token (ghu_)", () => {
    const token = "ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    expect(redactSecrets(token)).toBe("[REDACTED:github-token]");
  });

  it("redacts GitHub server-to-server token (ghs_)", () => {
    const token = "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    expect(redactSecrets(token)).toBe("[REDACTED:github-token]");
  });

  it("redacts GitHub refresh token (ghr_)", () => {
    const token = "ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    expect(redactSecrets(token)).toBe("[REDACTED:github-token]");
  });

  it("does not redact a GitHub token shorter than 36 chars after the prefix", () => {
    // 35 chars after ghp_ — must NOT match.
    const short = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01234";
    expect(redactSecrets(short)).toBe(short);
  });

  // -------------------------------------------------------------------------
  // api-key (sk- / sk-ant- prefixes)
  // -------------------------------------------------------------------------

  it("redacts an OpenAI-style API key (sk-)", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz012345";
    expect(redactSecrets(`key=${key}`)).toBe("key=[REDACTED:api-key]");
  });

  it("redacts an Anthropic-style API key (sk-ant-)", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz01234";
    expect(redactSecrets(`key=${key}`)).toBe("key=[REDACTED:api-key]");
  });

  it("does not redact an sk- value shorter than 20 chars", () => {
    const short = "sk-abc";
    expect(redactSecrets(short)).toBe(short);
  });

  // -------------------------------------------------------------------------
  // bearer
  // -------------------------------------------------------------------------

  it("redacts a Bearer authorization header", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    expect(redactSecrets(input)).toBe("Authorization: [REDACTED:bearer]");
  });

  it("redacts Bearer token regardless of token value", () => {
    expect(redactSecrets("Bearer somesimpletoken")).toBe("[REDACTED:bearer]");
  });

  // -------------------------------------------------------------------------
  // slack-token
  // -------------------------------------------------------------------------

  it("redacts a Slack bot token (xoxb-)", () => {
    const input = "SLACK_TOKEN=xoxb-1234567890-0987654321-abcdefghijklmnop";
    expect(redactSecrets(input)).toBe("SLACK_TOKEN=[REDACTED:slack-token]");
  });

  it("redacts a Slack user token (xoxp-)", () => {
    const input = "token: xoxp-0000000000-1111111111-abcdefghijklmnop";
    expect(redactSecrets(input)).toBe("token: [REDACTED:slack-token]");
  });

  // -------------------------------------------------------------------------
  // plan-owner-fence-token (T852): key-anchored, value-only replacement
  // -------------------------------------------------------------------------

  it("redacts a JSON-spelled owner fence token and keeps the surrounding syntax", () => {
    const input =
      '{"ok":true,"acknowledgement":{"claimId":"claim_G1_1","ownerFenceToken":"tZ3n5Qw8Lp2Rk9Vb4Xc7Ym"}}';
    expect(redactSecrets(input)).toBe(
      '{"ok":true,"acknowledgement":{"claimId":"claim_G1_1","ownerFenceToken":"[REDACTED:plan-owner-fence-token]"}}',
    );
  });

  it("redacts the YAML and shell spellings of an owner fence token", () => {
    expect(redactSecrets("ownerFenceToken: tZ3n5Qw8Lp2Rk9Vb4Xc7Ym")).toBe(
      "ownerFenceToken: [REDACTED:plan-owner-fence-token]",
    );
    expect(redactSecrets("ownerFenceToken=tZ3n5Qw8Lp2Rk9Vb4Xc7Ym")).toBe(
      "ownerFenceToken=[REDACTED:plan-owner-fence-token]",
    );
  });

  it("leaves the public verifier field and its digest untouched", () => {
    // Only the plaintext token is a secret; the SHA-256 verifier is what the
    // store legitimately persists.
    const input =
      '{"ownerFenceTokenVerifier":"5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8"}';
    expect(redactSecrets(input)).toBe(input);
  });

  it("does not redact an owner-fence value shorter than 22 chars", () => {
    // 21 chars — below the >=128-bit base64url floor the contract requires.
    const short = '{"ownerFenceToken":"tZ3n5Qw8Lp2Rk9Vb4Xc7"}';
    expect(redactSecrets(short)).toBe(short);
  });

  // ---- the ACTUAL on-disk byte shape: JSON-in-JSON --------------------------
  //
  // `redactSecrets` runs over the RAW transcript text (cq-cli/src/logPut.ts),
  // and a raw JSONL line stores an MCP tool result as a STRINGIFIED payload.
  // The bytes on disk are therefore escaped — `\"ownerFenceToken\":\"…\"` —
  // not the bare JSON every other case above exercises. These fixtures are
  // built by JSON.stringify-ing a message whose tool_result content is itself
  // a JSON string, so the escaping is produced the same way the real writer
  // produces it rather than hand-spelled.

  const FENCE_TOKEN = "tZ3n5Qw8Lp2Rk9Vb4Xc7Ym";

  /** One raw-JSONL line carrying `payload` as a stringified tool result. */
  function rawJsonlLine(payload: unknown): string {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: JSON.stringify(payload),
          },
        ],
      },
    });
  }

  const claimResponse = {
    ok: true,
    replayed: false,
    acknowledgement: {
      goalId: "G1",
      claimId: "claim_G1_1",
      generation: 1,
      ownerFenceToken: FENCE_TOKEN,
    },
  };

  it("redacts the token in the escaped JSON-in-JSON shape a raw JSONL line actually stores", () => {
    const line = rawJsonlLine(claimResponse);
    // Precondition: the fixture really is the escaped shape, not bare JSON.
    expect(line).toContain('\\"ownerFenceToken\\":\\"');
    expect(line).toContain(FENCE_TOKEN);

    const redacted = redactSecrets(line);
    expect(redacted).not.toContain(FENCE_TOKEN);
    expect(redacted).toContain("[REDACTED:plan-owner-fence-token]");
  });

  it("keeps the redacted raw JSONL line parseable at both nesting levels", () => {
    // `cq log put` validates JSONL AFTER redacting, so a replacement that ate
    // the closing quote would reject the whole artifact.
    const redacted = redactSecrets(rawJsonlLine(claimResponse));
    const envelope = JSON.parse(redacted) as {
      message: { content: Array<{ content: string }> };
    };
    const inner = JSON.parse(envelope.message.content[0]!.content) as {
      acknowledgement: { claimId: string; ownerFenceToken: string };
    };
    expect(inner.acknowledgement.ownerFenceToken).toBe(
      "[REDACTED:plan-owner-fence-token]",
    );
    // Public metadata around the secret survives untouched.
    expect(inner.acknowledgement.claimId).toBe("claim_G1_1");
  });

  it("redacts the doubly-escaped shape of a nested transcript capture", () => {
    // A transcript that quotes another transcript escapes a second time, so
    // the single-escaped spelling is no longer present verbatim.
    const singleEscaped = '\\"ownerFenceToken\\":';
    const line = rawJsonlLine(claimResponse);
    expect(line).toContain(singleEscaped);

    const doubled = JSON.stringify(line);
    expect(doubled).not.toContain(singleEscaped);
    expect(doubled).toContain(FENCE_TOKEN);
    expect(redactSecrets(doubled)).not.toContain(FENCE_TOKEN);
  });

  it("redacts the single-quoted spelling", () => {
    expect(redactSecrets(`ownerFenceToken: '${FENCE_TOKEN}'`)).toBe(
      "ownerFenceToken: '[REDACTED:plan-owner-fence-token]'",
    );
  });

  it("leaves the verifier untouched in the escaped shape too", () => {
    // The escape-crossing must not become a licence to eat the public digest.
    const line = rawJsonlLine({
      ownerFenceTokenVerifier:
        "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
    });
    expect(redactSecrets(line)).toBe(line);
  });

  it("is idempotent on the escaped raw JSONL shape", () => {
    const once = redactSecrets(rawJsonlLine(claimResponse));
    expect(redactSecrets(once)).toBe(once);
  });

  // -------------------------------------------------------------------------
  // Non-secret text is untouched
  // -------------------------------------------------------------------------

  it("leaves plain log text untouched", () => {
    const plain = "2024-01-01T00:00:00Z INFO server started on port 3000";
    expect(redactSecrets(plain)).toBe(plain);
  });

  it("leaves an empty string untouched", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("leaves unrelated structured text untouched", () => {
    const json = '{"status":"ok","code":200,"message":"all good"}';
    expect(redactSecrets(json)).toBe(json);
  });

  // -------------------------------------------------------------------------
  // Multiple patterns in one string
  // -------------------------------------------------------------------------

  it("redacts multiple different patterns in the same string", () => {
    const input = [
      "aws=AKIAIOSFODNN7EXAMPLE",
      "gh=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      "slack=xoxb-1234-5678",
    ].join(" ");
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED:aws-key]");
    expect(result).toContain("[REDACTED:github-token]");
    expect(result).toContain("[REDACTED:slack-token]");
    // Original secrets must be gone.
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
    expect(result).not.toContain("xoxb-1234-5678");
  });

  // -------------------------------------------------------------------------
  // Idempotence
  // -------------------------------------------------------------------------

  it("is idempotent on a string containing a secret", () => {
    const inputs = [
      "key=AKIAIOSFODNN7EXAMPLE",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      "Authorization: Bearer mytoken",
      "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxx01234",
      "xoxb-111-222-abc",
      '{"ownerFenceToken":"tZ3n5Qw8Lp2Rk9Vb4Xc7Ym"}',
    ];
    for (const input of inputs) {
      const once = redactSecrets(input);
      const twice = redactSecrets(once);
      expect(twice).toBe(once);
    }
  });

  it("is idempotent on plain text (no secrets)", () => {
    const plain = "nothing secret here";
    expect(redactSecrets(redactSecrets(plain))).toBe(redactSecrets(plain));
  });

  // -------------------------------------------------------------------------
  // Per-line scope
  // -------------------------------------------------------------------------

  it("redacts each line independently and does not corrupt adjacent lines", () => {
    const input = ["ok line", "key=AKIAIOSFODNN7EXAMPLE", "another ok line"].join("\n");
    const result = redactSecrets(input);
    const lines = result.split("\n");
    expect(lines[0]).toBe("ok line");
    expect(lines[1]).toBe("key=[REDACTED:aws-key]");
    expect(lines[2]).toBe("another ok line");
  });
});
