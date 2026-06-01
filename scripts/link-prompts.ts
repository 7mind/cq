#!/usr/bin/env bun
/**
 * (Re)create the Claude Code symlinks into the single-source `llm/` assets.
 *
 * The prompts live once under `llm/` (the cross-tool asset convention:
 * `llm/commands/<ns>/<name>.md`, `llm/agents/<name>.md`). The `.codex/prompts/*`
 * symlinks are committed; the `.claude/` tree is gitignored, so Claude users run
 * this after clone (`bun run link-prompts`) to materialise the slash-command and
 * agent symlinks Claude Code discovers. Idempotent: existing symlinks are
 * replaced and parent dirs are created as needed.
 *
 *   bun run link-prompts
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, lstat, unlink, symlink, readlink } from "node:fs/promises";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Each Claude link: its path, and the `llm/` source it points at. */
interface PromptLink {
  /** Link path, relative to the repo root. */
  readonly link: string;
  /** Source file under `llm/`, relative to the repo root. */
  readonly source: string;
}

const LINKS: readonly PromptLink[] = [
  { link: ".claude/commands/plan/start.md", source: "llm/commands/plan/start.md" },
  { link: ".claude/commands/plan/advance.md", source: "llm/commands/plan/advance.md" },
  { link: ".claude/agents/plan-advance.md", source: "llm/agents/plan-advance.md" },
  { link: ".claude/agents/plan-reviewer.md", source: "llm/agents/plan-reviewer.md" },
];

async function linkExists(absLink: string): Promise<boolean> {
  try {
    await lstat(absLink);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

for (const { link, source } of LINKS) {
  const absLink = path.join(REPO_ROOT, link);
  const absSource = path.join(REPO_ROOT, source);
  // Relative target so the link is location-independent (works from any clone).
  const relTarget = path.relative(path.dirname(absLink), absSource);

  await mkdir(path.dirname(absLink), { recursive: true });

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
