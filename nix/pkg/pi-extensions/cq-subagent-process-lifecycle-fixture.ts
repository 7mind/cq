import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const marker = process.argv[2];
if (marker === undefined) throw new Error("missing lifecycle fixture marker");

process.on("SIGTERM", () => {});
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  detached: false,
  stdio: "ignore",
});
if (descendant.pid === undefined) throw new Error("fixture descendant did not return a pid");
writeFileSync(marker, `${descendant.pid}\n`, "utf8");
setInterval(() => {}, 1_000);
