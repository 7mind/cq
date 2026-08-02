import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const marker = process.argv[2];
if (marker === undefined) throw new Error("missing lifecycle fixture marker");
const mode = process.argv[3] ?? "persistent";

process.on("SIGTERM", () => {});
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  detached: false,
  stdio: "ignore",
});
if (descendant.pid === undefined) throw new Error("fixture descendant did not return a pid");
writeFileSync(marker, `${descendant.pid}\n`, "utf8");
if (mode === "immediate-exit") {
  setTimeout(() => process.exit(0), 10);
} else if (mode !== "persistent") {
  throw new Error(`unknown lifecycle fixture mode: ${mode}`);
}
setInterval(() => {}, 1_000);
