#!/usr/bin/env -S bun run
/**
 * Seed examples/sample-ledger with a synthetic project so the UIs have
 * something to show. Re-runnable: wipes <root>/docs first, then bootstraps the
 * canonical ledgers and fills milestones (with a dependency DAG) + items.
 *
 *   bun run examples/seed-sample-ledger.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FsLedgerStore, type FieldValue } from "../packages/ledger/src/index.ts";

const ROOT = path.resolve(import.meta.dir, "sample-ledger");

async function main(): Promise<void> {
  await fs.rm(path.join(ROOT, "docs"), { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });

  const store = new FsLedgerStore({ root: ROOT });
  await store.init(); // bootstraps milestones + canonical ledgers (tasks, defects, …)

  // ── Milestones: a small dependency DAG ────────────────────────────────
  await store.createMilestone({ id: "M1", title: "Project Foundations" });
  await store.createMilestone({ id: "M2", title: "Core Ledger Engine", dependsOn: ["M1"] });
  await store.createMilestone({ id: "M3", title: "Web Console", dependsOn: ["M2"] });
  await store.createMilestone({
    id: "M4",
    title: "Public Launch",
    dependsOn: ["M2"],
    blockedBy: ["M3"],
  });
  await store.updateMilestone("M4", { status: "blocked" });

  const item = (
    ledger: string,
    milestoneId: string,
    status: string,
    fields: Record<string, FieldValue>,
  ): Promise<unknown> => store.createItem(ledger, milestoneId, { status, fields });

  // ── tasks ─────────────────────────────────────────────────────────────
  await item("tasks", "M1", "done", {
    headline: "Bootstrap the repository",
    description: "Initialise the Bun workspace, eslint/prettier, and the flake dev shell.",
    acceptance: "bun install + bun test green",
  });
  await item("tasks", "M1", "done", {
    headline: "Define the ledger data model",
    description: "Milestones own typed items; ids are per-ledger monotonic with a prefix.",
  });
  await item("tasks", "M1", "wip", {
    headline: "Wire up CI",
    description: "Run typecheck, lint and tests on every push.",
    tags: ["infra"],
  });
  await item("tasks", "M2", "wip", {
    headline: "Implement the markdown parser",
    description: "Frontmatter plus grouped items must round-trip losslessly.\nValues are stored as YAML field lines under each item heading.",
  });
  await item("tasks", "M2", "planned", {
    headline: "Add the file-store mutex + lockfile",
    description: "Serialise concurrent writers on a per-ledger lockfile so two processes cannot corrupt a file.",
  });
  await item("tasks", "M2", "planned", {
    headline: "Build the full-text search index",
    description: "Cross-ledger ranked search over item fields, backed by minisearch.",
    dependsOn: ["T4"],
  });
  await item("tasks", "M3", "planned", {
    headline: "Item table + detail panel",
    description: "Browse a ledger's items in a table; click one to view and edit its fields.",
  });
  await item("tasks", "M3", "blocked", {
    headline: "Milestone DAG layout",
    description: "Lay out the milestone dependency graph (dependsOn/blockedBy) as a left-to-right DAG.",
    blockedBy: ["T7"],
  });
  await item("tasks", "M4", "planned", {
    headline: "Marketing landing page",
    description: "A static page describing the project with install instructions.",
  });

  // ── defects (severity is required) ─────────────────────────────────────
  await item("defects", "M2", "open", {
    headline: "Parser drops a trailing newline on serialize",
    description: "Round-tripping a ledger removes the final newline, producing a noisy git diff.",
    severity: "minor",
  });
  await item("defects", "M3", "wip", {
    headline: "Status filter resets on page reload",
    description: "The selected status filter is not persisted, so a reload shows all items again.",
    severity: "major",
    rootCause: "filter state not persisted to the URL",
  });
  await item("defects", "M2", "resolved", {
    headline: "FTS ignores hyphenated ids",
    description: "Searching for an id like D-12 returned no results.",
    severity: "minor",
    fix: "tokenizer keeps id-shaped tokens whole",
  });

  // ── hypotheses ──────────────────────────────────────────────────────────
  await item("hypothesis", "M2", "open", {
    headline: "Lock contention degrades parallel writes",
    description: "Throughput drops sharply when several agents write the same ledger at once.",
    rationale: "two writers on the same ledger serialize on the lockfile",
  });
  await item("hypothesis", "M2", "uncertain", {
    headline: "minisearch splits ids on punctuation",
    description: "Ids containing punctuation may be tokenised into pieces, hurting recall.",
    evidence: ["search for D12 returns nothing"],
  });

  // ── questions ─────────────────────────────────────────────────────────
  await item("questions", "M1", "open", { question: "Which authentication model for the web console?", suggestions: ["none (local)", "reverse-proxy auth", "OIDC"] });
  await item("questions", "M3", "answered", { question: "SSR or SPA for the console?", answer: "SPA — it is a pure MCP client, no server-side data path" });

  // ── decisions ───────────────────────────────────────────────────────────
  await item("decisions", "M1", "locked", { headline: "Bun + TypeScript as the runtime/toolchain" });
  await item("decisions", "M2", "locked", { headline: "Markdown-backed storage (one file per ledger)", rationale: "human-readable, diffable, git-friendly" });
  await item("decisions", "M3", "proposed", { headline: "Render the dependency graph with a hand-rolled SVG layout" });

  // ── goals (title + description required) ─────────────────────────────────
  await item("goals", "M1", "building", {
    title: "Ship a self-hostable ledger platform",
    description: "An MCP server plus terminal and browser frontends for planning ledgers.",
  });

  await store.dispose();

  // Report what landed.
  const fresh = new FsLedgerStore({ root: ROOT });
  await fresh.init();
  const ledgers = fresh.enumerate();
  process.stdout.write(`seeded ${ROOT}/docs\n`);
  for (const name of ledgers) {
    const v = fresh.fetch(name);
    const n = v.milestones.reduce((acc, g) => acc + g.items.length, 0);
    process.stdout.write(`  ${name}: ${n} item(s)\n`);
  }
  await fresh.dispose();
}

void main().catch((e: unknown) => {
  process.stderr.write(`seed failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
