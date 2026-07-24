#!/usr/bin/env bun
/**
 * (Re)create the Claude Code symlinks into the single-source `cq-assets/` assets.
 *
 * The prompts live once under `../cq-assets/` (sibling workspace package:
 * `../cq-assets/commands/<ns>/<name>.md`, `../cq-assets/agents/<name>.md`). The
 * `.claude/` tree is gitignored, so Claude users run this after clone
 * (`bun run link-prompts`) to materialise the slash-command and agent symlinks
 * Claude Code discovers. Idempotent: existing symlinks are replaced and parent
 * dirs are created as needed.
 *
 *   bun run link-prompts
 *   bun run link-prompts -- --check   # exits non-zero if any target is missing
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, lstat, unlink, symlink, readlink, access } from "node:fs/promises";
import { PROMPT_ROLE_SOURCE_INVENTORY } from "../packages/cq-config/src/index.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Each Claude link: its path, and the `cq-assets/` source it points at. */
export interface PromptLink {
  /** Link path, relative to the repo root. */
  readonly link: string;
  /** Source file under `../cq-assets/`, relative to the repo root. */
  readonly source: string;
}

/** Every Claude link, projected from the canonical ordered prompt catalog. */
export const LINKS: readonly PromptLink[] = PROMPT_ROLE_SOURCE_INVENTORY.map((role) => ({
  link: `.claude/${role.source}`,
  source: `../cq-assets/${role.source}`,
}));

/** A link whose target does not resolve on disk. */
export interface MissingTarget {
  readonly link: string;
  readonly source: string;
  readonly absSource: string;
}

/**
 * Check which links have missing source targets.
 * Side-effect free — safe to call from tests without mutating `.claude/`.
 *
 * @returns Array of every entry in `links` whose `source` does not exist.
 */
export async function checkLinks(links: readonly PromptLink[]): Promise<MissingTarget[]> {
  const missing: MissingTarget[] = [];
  for (const { link, source } of links) {
    const absSource = path.join(REPO_ROOT, source);
    try {
      await access(absSource);
    } catch {
      missing.push({ link, source, absSource });
    }
  }
  return missing;
}

async function linkExists(absLink: string): Promise<boolean> {
  try {
    await lstat(absLink);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--check")) {
    const missing = await checkLinks(LINKS);
    if (missing.length > 0) {
      console.error("link-prompts --check: missing targets:");
      for (const { link, source, absSource } of missing) {
        console.error(`  ${link} -> ${source} (resolved: ${absSource})`);
      }
      process.exit(1);
    }
    console.log("link-prompts --check: all targets present.");
    return;
  }

  for (const { link, source } of LINKS) {
    const absLink = path.join(REPO_ROOT, link);
    const absSource = path.join(REPO_ROOT, source);
    // Relative target so the link is location-independent (works from any clone).
    const relTarget = path.relative(path.dirname(absLink), absSource);

    await mkdir(path.dirname(absLink), { recursive: true });

    // Assert the source exists before creating a symlink — fail loud so a
    // future relocation is caught immediately rather than silently producing a
    // dangling link.  Reuse the same existence check as checkLinks().
    const [missingSource] = await checkLinks([{ link, source }]);
    if (missingSource) {
      throw new Error(
        `link-prompts: source missing for link "${link}": ${missingSource.absSource}`,
      );
    }

    if (await linkExists(absLink)) {
      const stat = await lstat(absLink);
      if (!stat.isSymbolicLink()) {
        throw new Error(`refusing to replace non-symlink ${link}; remove it manually`);
      }
      await unlink(absLink);
    }

    await symlink(relTarget, absLink);
    console.log(`${link} -> ${await readlink(absLink)}`);
  }
}

// Guard creation loop: only run when this file is the entrypoint, not when imported.
if (import.meta.main) {
  await main();
}
