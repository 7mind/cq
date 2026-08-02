import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const marker = process.argv[2];
if (marker === undefined) throw new Error("missing marker path");

process.on("SIGTERM", () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: false,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(marker, "forked-after-term");
});

writeFileSync(`${marker}.ready`, "ready");
setInterval(() => {}, 1_000);
