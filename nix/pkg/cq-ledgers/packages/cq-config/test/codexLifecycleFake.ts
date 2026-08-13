#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readProcessIdentity, type ProcessIdentity } from "@cq/process-control";

const GROUP_MEMBER_FIXTURE = fileURLToPath(
  new URL("./codexGroupMemberFixture.ts", import.meta.url),
);

interface LaunchEnvelope {
  readonly attestationId: string;
  readonly generation: number;
}

function storedResultToolEvent(launch: LaunchEnvelope): string {
  return JSON.stringify({
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
                attestationId: launch.attestationId,
                generation: launch.generation,
                storedAt: "2026-08-13T09:00:00.000Z",
                outputDigest: "sha256:fake-codex-result",
              },
            }),
          },
        ],
      },
    },
  });
}

function publishFileSync(path: string, content: string): void {
  const publicationPath = `${path}.pending-${String(process.pid)}`;
  writeFileSync(publicationPath, content, "utf8");
  renameSync(publicationPath, path);
}

const input = (await new Response(Bun.stdin.stream()).text()).trim();
const launch = JSON.parse(input) as LaunchEnvelope;
const readyPath = process.env["CQ_TEST_CODEX_READY"];
const groupPath = process.env["CQ_TEST_CODEX_GROUP"];
const signalPath = process.env["CQ_TEST_CODEX_SIGNALS"];
const releasePath = process.env["CQ_TEST_CODEX_RELEASE"];
if (readyPath === undefined || groupPath === undefined || signalPath === undefined) {
  throw new Error(
    "fake Codex requires CQ_TEST_CODEX_READY, CQ_TEST_CODEX_GROUP, and CQ_TEST_CODEX_SIGNALS",
  );
}
publishFileSync(readyPath, `${String(process.pid)}\n`);

let processGroupText: string;
if (process.platform === "linux") {
  const stat = readFileSync(`/proc/${String(process.pid)}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("fake Codex read malformed /proc stat");
  const processGroup = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u)[2];
  if (processGroup === undefined) throw new Error("fake Codex read no PGID from /proc stat");
  processGroupText = processGroup;
} else {
  const processGroup = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
    encoding: "utf8",
  });
  if (processGroup.status !== 0) {
    throw new Error(`fake Codex could not resolve its PGID: ${processGroup.stderr.trim()}`);
  }
  processGroupText = processGroup.stdout;
}
const pgid = Number.parseInt(processGroupText.trim(), 10);
if (!Number.isSafeInteger(pgid) || pgid <= 1) {
  throw new Error(`fake Codex resolved invalid PGID ${JSON.stringify(processGroupText)}`);
}
const leader = await readProcessIdentity(pgid);
const target = await readProcessIdentity(process.pid);
if (leader === null || target === null) {
  throw new Error("fake Codex could not capture its registered group identities");
}

const mode = process.env["CQ_TEST_CODEX_MODE"];
const members: ProcessIdentity[] = [target];
if (mode === "wait") {
  const memberReady = `${groupPath}.member-ready`;
  const member = Bun.spawn([process.execPath, "run", GROUP_MEMBER_FIXTURE, memberReady], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const memberPid = Number.parseInt(readFileSync(memberReady, "utf8").trim(), 10);
      const memberIdentity = await readProcessIdentity(memberPid);
      if (memberIdentity !== null) {
        members.push(memberIdentity);
        break;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await Bun.sleep(2);
  }
  if (members.length !== 2) {
    member.kill("SIGTERM");
    throw new Error("fake Codex group member did not publish its identity");
  }
}

publishFileSync(
  groupPath,
  `${JSON.stringify({
    registration: { pgid, leader },
    members,
    identityHelper: process.env["CQ_PROCESS_IDENTITY_HELPER"] ?? null,
  })}\n`,
);

if (mode === "success") {
  process.stdout.write(
    `${[
      JSON.stringify({ type: "diagnostic", secret: "raw-child-output" }),
      storedResultToolEvent(launch),
      JSON.stringify({
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
      }),
    ].join("\n")}\n`,
  );
} else if (mode === "invalid-result") {
  if (releasePath === undefined) {
    throw new Error("invalid-result fake Codex requires CQ_TEST_CODEX_RELEASE");
  }
  for (;;) {
    try {
      readFileSync(releasePath, "utf8");
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await Bun.sleep(2);
  }
  process.stdout.write(
    `${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "not-a-dispatch-handle" },
    })}\n`,
  );
} else if (mode === "wait") {
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
} else {
  throw new Error(`fake Codex received unknown mode ${JSON.stringify(mode)}`);
}
