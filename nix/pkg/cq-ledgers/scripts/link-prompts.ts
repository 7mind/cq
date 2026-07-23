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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Each Claude link: its path, and the `cq-assets/` source it points at. */
export interface PromptLink {
  /** Link path, relative to the repo root. */
  readonly link: string;
  /** Source file under `../cq-assets/`, relative to the repo root. */
  readonly source: string;
}

/** Single source of truth for all Claude symlinks. Exported for tests and --check mode. */
export const LINKS: readonly PromptLink[] = [
  { link: ".claude/commands/cq/plan.md", source: "../cq-assets/commands/cq/plan.md" },
  { link: ".claude/commands/cq/plan/advance.md", source: "../cq-assets/commands/cq/plan/advance.md" },
  { link: ".claude/commands/cq/plan/follow-up.md", source: "../cq-assets/commands/cq/plan/follow-up.md" },
  { link: ".claude/agents/plan-advance.md", source: "../cq-assets/agents/plan-advance.md" },
  { link: ".claude/agents/plan-reviewer.md", source: "../cq-assets/agents/plan-reviewer.md" },
  { link: ".claude/commands/cq/implement/start.md", source: "../cq-assets/commands/cq/implement/start.md" },
  { link: ".claude/commands/cq/implement/advance.md", source: "../cq-assets/commands/cq/implement/advance.md" },
  { link: ".claude/agents/implement-worker.md", source: "../cq-assets/agents/implement-worker.md" },
  { link: ".claude/agents/implement-reviewer.md", source: "../cq-assets/agents/implement-reviewer.md" },
  { link: ".claude/agents/implement-conflict-resolver.md", source: "../cq-assets/agents/implement-conflict-resolver.md" },
  { link: ".claude/commands/cq/investigate.md", source: "../cq-assets/commands/cq/investigate.md" },
  { link: ".claude/commands/cq/investigate/advance.md", source: "../cq-assets/commands/cq/investigate/advance.md" },
  { link: ".claude/agents/investigate-explorer.md", source: "../cq-assets/agents/investigate-explorer.md" },
  { link: ".claude/agents/investigate-prober.md", source: "../cq-assets/agents/investigate-prober.md" },
  { link: ".claude/commands/cq/research.md", source: "../cq-assets/commands/cq/research.md" },
  { link: ".claude/commands/cq/research/advance.md", source: "../cq-assets/commands/cq/research/advance.md" },
  { link: ".claude/agents/research-explorer.md", source: "../cq-assets/agents/research-explorer.md" },
  { link: ".claude/agents/research-experimenter.md", source: "../cq-assets/agents/research-experimenter.md" },
  { link: ".claude/commands/cq/begin.md", source: "../cq-assets/commands/cq/begin.md" },
  { link: ".claude/commands/cq/advance.md", source: "../cq-assets/commands/cq/advance.md" },
  { link: ".claude/commands/cq/plan-review.md", source: "../cq-assets/commands/cq/plan-review.md" },
  { link: ".claude/commands/cq/implement-review.md", source: "../cq-assets/commands/cq/implement-review.md" },
  { link: ".claude/commands/cq/reviewers.md", source: "../cq-assets/commands/cq/reviewers.md" },
  { link: ".claude/commands/cq/planners.md", source: "../cq-assets/commands/cq/planners.md" },
];

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
