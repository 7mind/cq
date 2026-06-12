/**
 * Unit assertions for T443 — canonical storage-path constants.
 *
 * Acceptance coverage:
 *   1. LEDGER_LOGS_RELATIVE_PREFIX === `${LEDGER_STORAGE_DIRNAME}/logs`.
 *   2. LEDGER_LOGS_STRIP_RE matches ".cq/logs/x" and does NOT match "docs/logs/x".
 *   3. new FsLedgerStore({root}) + init() writes ledger artifacts under
 *      "<root>/.cq/" (ledgers.yaml at <root>/.cq/ledgers.yaml), not <root>/docs/.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  LEDGER_STORAGE_DIRNAME,
  LEDGER_LOGS_DIRNAME,
  LEDGER_LOGS_RELATIVE_PREFIX,
  LEDGER_LOGS_STRIP_RE,
  FsLedgerStore,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// (1) Derived-value assertion: LEDGER_LOGS_RELATIVE_PREFIX
// ---------------------------------------------------------------------------

describe("LEDGER_LOGS_RELATIVE_PREFIX derivation", () => {
  it("equals `${LEDGER_STORAGE_DIRNAME}/${LEDGER_LOGS_DIRNAME}`", () => {
    expect(LEDGER_LOGS_RELATIVE_PREFIX).toBe(
      `${LEDGER_STORAGE_DIRNAME}/${LEDGER_LOGS_DIRNAME}`,
    );
  });

  it("equals '.cq/logs'", () => {
    // Belt-and-suspenders: also assert the concrete value so a rename is loud.
    expect(LEDGER_LOGS_RELATIVE_PREFIX).toBe(".cq/logs");
  });
});

// ---------------------------------------------------------------------------
// (2) Strip-RE assertion
// ---------------------------------------------------------------------------

describe("LEDGER_LOGS_STRIP_RE matches/rejects", () => {
  it("matches '.cq/logs/x' and strips the prefix", () => {
    expect(LEDGER_LOGS_STRIP_RE.test(".cq/logs/x")).toBe(true);
    expect(".cq/logs/x".replace(LEDGER_LOGS_STRIP_RE, "")).toBe("x");
  });

  it("matches '.cq/logs/raw/20260601-abc.jsonl' and strips the prefix", () => {
    const input = ".cq/logs/raw/20260601-abc.jsonl";
    expect(LEDGER_LOGS_STRIP_RE.test(input)).toBe(true);
    expect(input.replace(LEDGER_LOGS_STRIP_RE, "")).toBe("raw/20260601-abc.jsonl");
  });

  it("does NOT match 'docs/logs/x'", () => {
    expect(LEDGER_LOGS_STRIP_RE.test("docs/logs/x")).toBe(false);
  });

  it("does NOT match a plain filename without prefix", () => {
    expect(LEDGER_LOGS_STRIP_RE.test("20260601-abc.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (3) FsLedgerStore writes artifacts under <root>/.cq/ after init()
// ---------------------------------------------------------------------------

describe("FsLedgerStore writes under <root>/.cq/", () => {
  it("ledgers.yaml lives at <root>/.cq/ledgers.yaml, not <root>/docs/ledgers.yaml", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ledger-storage-cq-"));
    dirs.push(root);

    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    // The canonical registry must exist under .cq/, not docs/.
    const cqRegistry = path.join(root, LEDGER_STORAGE_DIRNAME, "ledgers.yaml");
    const docsRegistry = path.join(root, "docs", "ledgers.yaml");

    const cqStat = await stat(cqRegistry);
    expect(cqStat.isFile()).toBe(true);

    // docs/ must not have been created at all.
    let docsDirExists = false;
    try {
      await stat(path.join(root, "docs"));
      docsDirExists = true;
    } catch {
      docsDirExists = false;
    }
    expect(docsDirExists).toBe(false);

    // Belt-and-suspenders: the docs/ledgers.yaml path must NOT exist.
    let docsRegistryExists = false;
    try {
      await stat(docsRegistry);
      docsRegistryExists = true;
    } catch {
      docsRegistryExists = false;
    }
    expect(docsRegistryExists).toBe(false);
  });

  it("milestones.md lives at <root>/.cq/milestones.md after init()", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ledger-storage-cq-ms-"));
    dirs.push(root);

    const store = new FsLedgerStore({ root });
    await store.init();
    await store.dispose();

    const milestonesMd = path.join(root, LEDGER_STORAGE_DIRNAME, "milestones.md");
    const s = await stat(milestonesMd);
    expect(s.isFile()).toBe(true);
  });
});
