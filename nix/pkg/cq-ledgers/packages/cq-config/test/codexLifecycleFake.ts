#!/usr/bin/env bun

import { appendFileSync, writeFileSync } from "node:fs";

interface LaunchEnvelope {
  readonly attestationId: string;
  readonly generation: number;
}

const input = (await new Response(Bun.stdin.stream()).text()).trim();
const launch = JSON.parse(input) as LaunchEnvelope;
const readyPath = process.env["CQ_TEST_CODEX_READY"];
const groupRolePath = process.env["CQ_TEST_CODEX_GROUP_ROLE"];
const signalPath = process.env["CQ_TEST_CODEX_SIGNALS"];
if (readyPath === undefined || groupRolePath === undefined || signalPath === undefined) {
  throw new Error(
    "fake Codex requires CQ_TEST_CODEX_READY, CQ_TEST_CODEX_GROUP_ROLE, and CQ_TEST_CODEX_SIGNALS",
  );
}
writeFileSync(readyPath, `${String(process.pid)}\n`, "utf8");
let groupRole: "leader" | "member";
try {
  process.kill(-process.pid, 0);
  groupRole = "leader";
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  groupRole = "member";
}
writeFileSync(groupRolePath, `${groupRole}\n`, "utf8");

if (process.env["CQ_TEST_CODEX_MODE"] === "success") {
  process.stdout.write(
    `${JSON.stringify({ type: "diagnostic", secret: "raw-child-output" })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify({
          state: "result-stored",
          attestationId: launch.attestationId,
          generation: launch.generation,
          outputDigest: "sha256:fake-codex-result",
        }),
      },
    })}\n`,
  );
} else {
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    appendFileSync(signalPath, `${signal}\n`, "utf8");
    setTimeout(() => process.exit(0), 25);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  await new Promise<void>(() => {});
}
