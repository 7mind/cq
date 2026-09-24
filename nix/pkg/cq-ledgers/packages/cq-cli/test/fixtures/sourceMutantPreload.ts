/**
 * D543: serve a mutated copy of one production source file to a child
 * `bun test` in memory, so a mutation-control test never rewrites the
 * tracked file. Relative imports still resolve from the real path.
 */

import { readFileSync } from "node:fs";
import {
  SOURCE_MUTANT_FIND_ENV,
  SOURCE_MUTANT_REPLACE_ENV,
  SOURCE_MUTANT_TARGET_ENV,
} from "./sourceMutantEnv.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`sourceMutantPreload: ${name} is required`);
  return value;
}

const target = requireEnv(SOURCE_MUTANT_TARGET_ENV);
const find = requireEnv(SOURCE_MUTANT_FIND_ENV);
const replace = requireEnv(SOURCE_MUTANT_REPLACE_ENV);
const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

Bun.plugin({
  name: "cq-source-mutant",
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escapedTarget}$`) }, () => {
      const source = readFileSync(target, "utf8");
      if (!source.includes(find)) {
        throw new Error(`sourceMutantPreload: mutation anchor missing from ${target}`);
      }
      return { contents: source.replace(find, replace), loader: "ts" };
    });
  },
});
