/**
 * Tests for the normalize-suggestions script:
 *  - The pure `normalizeSuggestions` logic function.
 *  - End-to-end store-level normalization via SqliteLedgerStore + the
 *    `needsNormalization` helper (exercises the same path the script takes).
 *  - Idempotence: a second normalization pass produces no structural change.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createManagementLedgerStore,
  QUESTIONS_LEDGER,
  MILESTONES_AMBIENT_ID,
} from "../src/index.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import {
  normalizeSuggestions,
  needsNormalization,
} from "../src/normalizeSuggestions.js";

// ---------------------------------------------------------------------------
// Unit tests for the pure normalization function.
// ---------------------------------------------------------------------------

describe("normalizeSuggestions — pure logic", () => {
  it("already-split array is returned unchanged (structurally)", () => {
    const input = ["alpha", "beta", "gamma"];
    expect(normalizeSuggestions(input)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("semicolon-joined single element is split and trimmed", () => {
    expect(normalizeSuggestions(["a; b; c"])).toEqual(["a", "b", "c"]);
  });

  it("newline-joined single element is split and trimmed", () => {
    expect(normalizeSuggestions(["a\nb\nc"])).toEqual(["a", "b", "c"]);
  });

  it("mixed semicolons and newlines", () => {
    expect(normalizeSuggestions(["a; b\nc; d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("bare string is treated as single-element array", () => {
    expect(normalizeSuggestions("x; y")).toEqual(["x", "y"]);
  });

  it("extra whitespace around fragments is trimmed", () => {
    expect(normalizeSuggestions(["  a ;  b  ;  c  "])).toEqual(["a", "b", "c"]);
  });

  it("empty fragments are dropped", () => {
    expect(normalizeSuggestions(["a;;b"])).toEqual(["a", "b"]);
  });

  it("undefined returns empty array", () => {
    expect(normalizeSuggestions(undefined)).toEqual([]);
  });

  it("empty array returns empty array", () => {
    expect(normalizeSuggestions([])).toEqual([]);
  });

  it("multi-element array with some semicolons flattens correctly", () => {
    expect(normalizeSuggestions(["a; b", "c", "d; e"])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});

// ---------------------------------------------------------------------------
// needsNormalization
// ---------------------------------------------------------------------------

describe("needsNormalization", () => {
  it("returns false for already-split array", () => {
    expect(needsNormalization(["a", "b", "c"])).toBe(false);
  });

  it("returns true for semicolon-joined element", () => {
    expect(needsNormalization(["a; b; c"])).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(needsNormalization(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Store-level integration: seed fixture, normalize, assert, idempotence.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
const WORKSPACE_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const NORMALIZE_SCRIPT = path.join(WORKSPACE_ROOT, "scripts", "normalize-suggestions.ts");

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
}

async function makeStore(): Promise<{ store: SqliteLedgerStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "normalize-suggestions-"));
  tmpDirs.push(dir);
  const store = new SqliteLedgerStore({ dbPath: path.join(dir, "ledger.db") });
  await store.init();
  return { store };
}

/** Run the normalization pass over the questions ledger in `store`. */
async function runNormalizationPass(store: SqliteLedgerStore): Promise<number> {
  const ledger = store.fetch(QUESTIONS_LEDGER);
  let writes = 0;
  for (const group of ledger.milestones) {
    for (const item of group.items) {
      const raw = item.fields["suggestions"];
      if (!needsNormalization(raw)) continue;
      const normalized = normalizeSuggestions(raw);
      await store.updateItem(QUESTIONS_LEDGER, item.id, {
        fields: { suggestions: normalized },
        author: "test",
      });
      writes++;
    }
  }
  return writes;
}

describe("normalize-suggestions — store-level (SqliteLedgerStore)", () => {
  it("normalizes semicolon-joined suggestions and is idempotent", async () => {
    const { store } = await makeStore();

    const item = await store.createItem(
      QUESTIONS_LEDGER,
      MILESTONES_AMBIENT_ID,
      {
        status: "open",
        fields: {
          question: "Which option?",
          suggestions: ["option a; option b; option c"],
        },
        author: "test-seed",
      },
    );

    const before = store.fetchItem(QUESTIONS_LEDGER, item.id);
    expect(before.fields["suggestions"]).toEqual(["option a; option b; option c"]);

    const writesFirst = await runNormalizationPass(store);
    expect(writesFirst).toBe(1);

    const after = store.fetchItem(QUESTIONS_LEDGER, item.id);
    expect(after.fields["suggestions"]).toEqual(["option a", "option b", "option c"]);

    // second pass is a no-op (idempotent)
    const writesSecond = await runNormalizationPass(store);
    expect(writesSecond).toBe(0);

    const after2 = store.fetchItem(QUESTIONS_LEDGER, item.id);
    expect(after2.fields["suggestions"]).toEqual(["option a", "option b", "option c"]);

    await store.dispose();
  });

  it("skips items that already have properly split suggestions", async () => {
    const { store } = await makeStore();

    await store.createItem(
      QUESTIONS_LEDGER,
      MILESTONES_AMBIENT_ID,
      {
        status: "open",
        fields: {
          question: "Choose one",
          suggestions: ["yes", "no", "maybe"],
        },
        author: "test-seed",
      },
    );

    const writes = await runNormalizationPass(store);
    expect(writes).toBe(0);

    await store.dispose();
  });

  it("normalizes newline-joined suggestions", async () => {
    const { store } = await makeStore();

    const item = await store.createItem(
      QUESTIONS_LEDGER,
      MILESTONES_AMBIENT_ID,
      {
        status: "open",
        fields: {
          question: "Which framework?",
          suggestions: ["React\nVue\nSvelte"],
        },
        author: "test-seed",
      },
    );

    await runNormalizationPass(store);

    const after = store.fetchItem(QUESTIONS_LEDGER, item.id);
    expect(after.fields["suggestions"]).toEqual(["React", "Vue", "Svelte"]);

    await store.dispose();
  });
});

describe("normalize-suggestions — backup durability [Behavioral-Active Effectual-GoodCommunication]", () => {
  // Regression-origin: the command must drain its managed backup before exit.
  it('flushes a configured backup="in-tree" after normalization', async () => {
    const root = await mkdtemp(path.join(tmpdir(), "normalize-suggestions-backup-"));
    const xdgStateHome = await mkdtemp(path.join(tmpdir(), "normalize-suggestions-xdg-"));
    tmpDirs.push(root, xdgStateHome);
    await writeFile(path.join(root, "README.md"), "# normalize fixture\n");
    await writeFile(
      path.join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nbackup = "in-tree"\n',
    );
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "user.email", "test@example.com"]);
    runGit(root, ["config", "user.name", "test"]);
    runGit(root, ["add", "README.md", "cq.toml"]);
    runGit(root, ["commit", "-qm", "fixture"]);

    const originalXdgStateHome = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = xdgStateHome;
    try {
      const seeded = await createManagementLedgerStore(root);
      try {
        await seeded.store.createItem(QUESTIONS_LEDGER, MILESTONES_AMBIENT_ID, {
          status: "open",
          fields: { question: "Choose", suggestions: ["a; b"] },
          author: "test-seed",
        });
      } finally {
        seeded.backup?.close();
        await seeded.store.dispose();
      }

      const child = Bun.spawn([process.execPath, "run", NORMALIZE_SCRIPT, "--cwd", root], {
        cwd: WORKSPACE_ROOT,
        env: { ...process.env, XDG_STATE_HOME: xdgStateHome },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(`${stdout}\n${stderr}`).toContain("1 updated");
      await access(path.join(root, ".cq", "ledgers.yaml"));
    } finally {
      if (originalXdgStateHome === undefined) {
        delete process.env["XDG_STATE_HOME"];
      } else {
        process.env["XDG_STATE_HOME"] = originalXdgStateHome;
      }
    }
  });
});

afterAll(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});
