#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

const readyPath = process.argv[2];
if (readyPath === undefined) throw new Error("Codex group member requires a ready path");
writeFileSync(readyPath, `${String(process.pid)}\n`, "utf8");

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 25);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise<void>(() => {});
