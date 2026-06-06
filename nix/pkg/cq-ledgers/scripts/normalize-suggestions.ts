#!/usr/bin/env bun
/**
 * One-shot normalization of `suggestions` field in the `questions` ledger.
 *
 * Legacy items may store suggestions as a single element containing
 * semicolon- or newline-joined values, e.g. `["a; b; c"]` instead of
 * `["a", "b", "c"]`. This script rewrites every `questions` item whose
 * `suggestions` contains embedded semicolons or newlines so that each
 * element is a single trimmed option.
 *
 * Idempotent: already-normalized items (no embedded ;/newline) are
 * untouched — a second run produces no writes.
 *
 * Usage:
 *   bun run scripts/normalize-suggestions.ts [--cwd /path/to/repo]
 *
 * --cwd defaults to the process working directory (the repo root, where docs/ lives).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FsLedgerStore,
  QUESTIONS_LEDGER,
} from "../packages/ledger/src/index.js";
import {
  normalizeSuggestions,
  needsNormalization,
} from "../packages/ledger/src/normalizeSuggestions.js";

const args = process.argv.slice(2);
const cwdIdx = args.indexOf("--cwd");
const cwdArg: string | undefined = args[cwdIdx + 1];
const root =
  cwdIdx >= 0 && cwdArg !== undefined
    ? path.resolve(cwdArg)
    : path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
      );

const store = new FsLedgerStore({ root });
await store.init();

const ledger = store.fetch(QUESTIONS_LEDGER);

let updated = 0;
let skipped = 0;

for (const group of ledger.milestones) {
  for (const item of group.items) {
    const raw = item.fields["suggestions"];
    if (!needsNormalization(raw)) {
      skipped++;
      continue;
    }
    const normalized = normalizeSuggestions(raw);
    await store.updateItem(QUESTIONS_LEDGER, item.id, {
      fields: { suggestions: normalized },
      author: "normalize-suggestions-script",
    });
    console.log(
      `  updated ${item.id}: ${JSON.stringify(raw)} → ${JSON.stringify(normalized)}`,
    );
    updated++;
  }
}

await store.dispose();

console.log(
  `\nnormalize-suggestions complete: ${updated} updated, ${skipped} already-normalized (skipped).`,
);
