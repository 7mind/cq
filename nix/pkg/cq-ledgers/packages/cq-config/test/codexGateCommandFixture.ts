import { appendFileSync, writeFileSync } from "node:fs";

const readyPath = process.argv[2];
const signalPath = process.argv[3];
if (readyPath === undefined || signalPath === undefined) {
  throw new Error("gate fixture requires ready and signal paths");
}
writeFileSync(readyPath, `${String(process.pid)}\n`, "utf8");

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
