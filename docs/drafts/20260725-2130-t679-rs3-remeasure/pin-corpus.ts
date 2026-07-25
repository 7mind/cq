/**
 * T679 — pin the RS3 corpus.
 *
 * RS3 (researches:RS3, log `20260724-121500-research-RS3.md`) measured
 * "357/357 raw JSONL transcripts parsed, 95,152,796 bytes" out of the cq xdg
 * raw-log area of the project key that also holds the RS3 session logs
 * (`.../projects/9faab3c136afe411b16a43206b14f834382ed440/logs/`). That
 * directory keeps growing, so the identity of the RS3 corpus is recovered here
 * as the set of `*.jsonl` files whose mtime predates the RS3 measurement
 * (2026-07-24T11:00 local) and pinned as an explicit manifest of
 * name/size/sha256. The manifest — not an mtime filter — is what later runs
 * verify against.
 *
 * Usage:
 *   bun run pin-corpus.ts [--corpus <dir>] [--cutoff <ISO>] [--out <file>]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DEFAULT_CORPUS_ROOT =
  "/home/pavel/.local/state/cq/projects/9faab3c136afe411b16a43206b14f834382ed440/logs/raw";
export const RS3_FILE_COUNT = 357;
export const RS3_TOTAL_BYTES = 95_152_796;
const DEFAULT_CUTOFF = "2026-07-24T11:00:00";

export interface CorpusEntry {
  name: string;
  bytes: number;
  sha256: string;
}

export interface CorpusManifest {
  description: string;
  rs3PinnedSourceCommit: string;
  corpusRoot: string;
  fileCount: number;
  totalBytes: number;
  files: CorpusEntry[];
}

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (value === undefined) throw new Error(`--${name} needs a value`);
  return value;
}

function main(): void {
  const root = resolve(arg("corpus", DEFAULT_CORPUS_ROOT));
  const cutoff = Date.parse(arg("cutoff", DEFAULT_CUTOFF));
  if (Number.isNaN(cutoff)) throw new Error("--cutoff must be a parseable date");
  const out = resolve(arg("out", join(import.meta.dir, "corpus-manifest.json")));

  const files: CorpusEntry[] = [];
  let totalBytes = 0;
  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const stat = statSync(join(root, name));
    if (stat.mtimeMs >= cutoff) continue;
    const bytes = stat.size;
    const sha256 = createHash("sha256")
      .update(readFileSync(join(root, name)))
      .digest("hex");
    files.push({ name, bytes, sha256 });
    totalBytes += bytes;
  }

  if (files.length !== RS3_FILE_COUNT) {
    throw new Error(
      `expected ${RS3_FILE_COUNT} RS3 transcripts, found ${files.length}`,
    );
  }
  if (totalBytes !== RS3_TOTAL_BYTES) {
    throw new Error(
      `expected ${RS3_TOTAL_BYTES} corpus bytes, found ${totalBytes}`,
    );
  }

  const manifest: CorpusManifest = {
    description:
      "RS3 corpus (researches:RS3): raw cq subagent JSONL transcripts as they stood at the RS3 measurement. Pinned by name/size/sha256 so re-runs measure the identical corpus.",
    rs3PinnedSourceCommit: "3fe3b8a7935f3027218581e76bb9da2ce1b833e2",
    corpusRoot: root,
    fileCount: files.length,
    totalBytes,
    files,
  };
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `pinned ${files.length} transcripts, ${totalBytes} bytes -> ${out}`,
  );
}

main();
