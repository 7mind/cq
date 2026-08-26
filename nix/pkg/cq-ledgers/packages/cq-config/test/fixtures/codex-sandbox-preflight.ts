import { appendFileSync } from "node:fs";

export {};

/**
 * T1999 fake Codex for the D266 sandbox pre-flight. Env-driven:
 *  - CQ_TEST_CODEX_SANDBOX_MODE: "healthy" runs the probed command verbatim
 *    (no sandbox emulation); "broken" and "broken-tmpdir" emit the canned
 *    reports the broken codex 0.146 read-only sandbox produces.
 *  - CQ_TEST_CODEX_ARGV_LOG receives one JSON argv array per invocation so
 *    tests can assert probe-vs-exec ordering and the TMPDIR override.
 * The `exec` mode consumes the compact launch envelope and emits a valid
 * digest-bound result-stored stream, mirroring codexLifecycleFake "success".
 */
const mode = process.env["CQ_TEST_CODEX_SANDBOX_MODE"];
const logPath = process.env["CQ_TEST_CODEX_ARGV_LOG"];
if (
  mode === undefined ||
  !["healthy", "broken", "broken-tmpdir"].includes(mode) ||
  logPath === undefined
) {
  throw new Error(
    "fake Codex requires CQ_TEST_CODEX_SANDBOX_MODE (healthy|broken|broken-tmpdir) and CQ_TEST_CODEX_ARGV_LOG",
  );
}
const argv = process.argv.slice(2);
appendFileSync(logPath, `${JSON.stringify(argv)}\n`, "utf8");

if (argv[0] === "sandbox") {
  if (mode === "broken") {
    process.stdout.write(
      `${JSON.stringify({
        pipeStdout: "",
        pipeStatus: 0,
        pipeError: null,
        tmpdir: "/dev/shm",
        mkdtemp: "/dev/shm/cq-sandbox-preflight-fake",
      })}\n`,
    );
    process.exit(1);
  }
  if (mode === "broken-tmpdir") {
    const brokenTmpdir = process.platform === "darwin" ? "/dev/shm" : "/tmp";
    process.stdout.write(
      `${JSON.stringify({
        pipeStdout: "1\n",
        pipeStatus: 0,
        pipeError: null,
        tmpdir: brokenTmpdir,
        mkdtemp: `${brokenTmpdir}/cq-sandbox-preflight-fake`,
      })}\n`,
    );
    process.exit(1);
  }
  const separator = argv.indexOf("--");
  if (separator < 0) throw new Error("fake Codex sandbox lost its -- separator");
  const child = Bun.spawn(argv.slice(separator + 1), {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}

const launch = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
process.stdout.write(
  `${JSON.stringify({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "ledger",
      tool: "store_result",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              state: "result-stored",
              result: {
                state: "result-stored",
                attestationId: launch["attestationId"],
                generation: launch["generation"],
                storedAt: "2026-08-13T09:00:00.000Z",
                outputDigest: "sha256:fake-codex-sandbox-result",
              },
            }),
          },
        ],
      },
    },
  })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        state: "result-stored",
        attestationId: launch["attestationId"],
        generation: launch["generation"],
        outputDigest: "sha256:fake-codex-sandbox-result",
      }),
    },
  })}\n`,
);
