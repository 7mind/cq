import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GROUP_MEMBER_FIXTURE = fileURLToPath(
  new URL("./codexGroupMemberFixture.ts", import.meta.url),
);

const readyPath = process.argv[2];
const signalPath = process.argv[3];
if (readyPath === undefined || signalPath === undefined) {
  throw new Error("gate fixture requires ready and signal paths");
}
const memberReady = `${readyPath}.member`;
const member = Bun.spawn([process.execPath, "run", GROUP_MEMBER_FIXTURE, memberReady], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
let memberPid: number | undefined;
for (let attempt = 0; attempt < 500; attempt += 1) {
  try {
    const candidate = Number.parseInt(readFileSync(memberReady, "utf8").trim(), 10);
    if (Number.isSafeInteger(candidate) && candidate > 1) {
      memberPid = candidate;
      break;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await Bun.sleep(2);
}
if (memberPid === undefined) {
  member.kill("SIGTERM");
  throw new Error("gate fixture member did not publish its PID");
}
writeFileSync(
  readyPath,
  `${JSON.stringify({ targetPid: process.pid, memberPid })}\n`,
  "utf8",
);

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
