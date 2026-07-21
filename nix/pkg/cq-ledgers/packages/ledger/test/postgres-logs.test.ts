/**
 * PostgresLedgerStore log artifacts (T575, Q274/Q285): the tenant-keyed
 * `logs` table (T572 schema) serves the SAME `ReadLogCapability` contract as
 * `SqliteLedgerStore.readLog` (incl. `MAX_READ_LOG_BYTES` truncation + path
 * confinement), plus a store-side `putLog` write path and a `listLogs`
 * enumeration seam (review R690) that `buildBackupDump` prefers over a
 * filesystem `logsDir` when present.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as postgres-schema.test.ts /
 * store-postgres.test.ts): no Postgres server in this sandbox/CI, so the
 * suite SKIPS cleanly offline. Tenant isolation per test via a fresh
 * `project_key` (mirrors store-postgres.test.ts's `prepareTenant`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openPgPool } from "../src/store/postgres/connection.js";
import { ensureSchema } from "../src/store/postgres/schema.js";
import { PostgresLedgerStore } from "../src/store/postgres/PostgresLedgerStore.js";
import { MAX_READ_LOG_BYTES } from "../src/mcp/readLog.js";
import { buildBackupDump } from "../src/store/backupExporter.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

describe.skipIf(!PG_URL)("PostgresLedgerStore log artifacts (T575)", () => {
  const setupPool = PG_URL !== undefined ? openPgPool(PG_URL) : undefined;
  const schemaReady = setupPool !== undefined ? ensureSchema(setupPool) : Promise.resolve();

  async function registerTenant(): Promise<string> {
    await schemaReady;
    const projectKey = `t575-${randomUUID()}`;
    await setupPool!`
      INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})
    `;
    return projectKey;
  }

  async function buildStore(): Promise<{ store: PostgresLedgerStore; projectKey: string }> {
    const projectKey = await registerTenant();
    const store = new PostgresLedgerStore({ pool: openPgPool(PG_URL!), projectKey });
    await store.init();
    return { store, projectKey };
  }

  afterAll(async () => {
    await setupPool?.close();
  });

  test("putLog + readLog round trip: byte-identical content, path echoed back verbatim", async () => {
    const { store } = await buildStore();
    try {
      const md = "# Session log\n\nSome markdown content.\n";
      await store.putLog("20260101-abc.md", md);
      const res = await store.readLog("20260101-abc.md");
      expect(res.path).toBe("20260101-abc.md");
      expect(res.content).toBe(md);
      expect(res.truncated).toBeUndefined();

      const jsonl = [`{"event":"start"}`, `{"event":"end"}`].join("\n") + "\n";
      await store.putLog("raw/20260101-abc.jsonl", jsonl);
      const res2 = await store.readLog("raw/20260101-abc.jsonl");
      expect(res2.content).toBe(jsonl);
    } finally {
      await store.dispose();
    }
  });

  test("readLog accepts a repo-relative .cq/logs/ path without doubling the prefix", async () => {
    const { store } = await buildStore();
    try {
      await store.putLog("session.md", "hello log\n");
      const res = await store.readLog(".cq/logs/session.md");
      expect(res.content).toBe("hello log\n");
      expect(res.path).toBe(".cq/logs/session.md");
    } finally {
      await store.dispose();
    }
  });

  test("readLog rejects an absolute path", async () => {
    const { store } = await buildStore();
    try {
      await expect(store.readLog("/etc/passwd")).rejects.toThrow(/absolute paths are not allowed/);
    } finally {
      await store.dispose();
    }
  });

  test("readLog rejects a `..` escape outside logs/", async () => {
    const { store } = await buildStore();
    try {
      await expect(store.readLog("../secret.md")).rejects.toThrow(/escapes .*logs/);
    } finally {
      await store.dispose();
    }
  });

  test("putLog rejects an escaping path the same way readLog does", async () => {
    const { store } = await buildStore();
    try {
      await expect(store.putLog("../secret.md", "x")).rejects.toThrow(/escapes .*logs/);
    } finally {
      await store.dispose();
    }
  });

  test("readLog truncates an oversized artifact and flags truncated:true", async () => {
    const { store } = await buildStore();
    try {
      const big = "x".repeat(MAX_READ_LOG_BYTES + 1024);
      await store.putLog("big.log", big);
      const res = await store.readLog("big.log");
      expect(res.truncated).toBe(true);
      expect(res.content.length).toBe(MAX_READ_LOG_BYTES);
    } finally {
      await store.dispose();
    }
  });

  test("readLog throws for a genuinely missing log", async () => {
    const { store } = await buildStore();
    try {
      await expect(store.readLog("nonexistent.log")).rejects.toThrow();
    } finally {
      await store.dispose();
    }
  });

  test("putLog upserts: a re-put of the same path overwrites rather than conflicts", async () => {
    const { store } = await buildStore();
    try {
      await store.putLog("session.md", "v1\n");
      await store.putLog("session.md", "v2\n");
      const res = await store.readLog("session.md");
      expect(res.content).toBe("v2\n");
    } finally {
      await store.dispose();
    }
  });

  test("listLogs enumerates exactly the connecting tenant's log paths — a second tenant's logs are invisible", async () => {
    const { store: storeA } = await buildStore();
    const { store: storeB } = await buildStore();
    try {
      await storeA.putLog("a1.md", "A1 content\n");
      await storeA.putLog("raw/a2.jsonl", `{"a":2}\n`);
      await storeB.putLog("b1.md", "B1 content\n");

      const aEntries = [];
      for await (const e of storeA.listLogs()) aEntries.push(e);
      aEntries.sort((x, y) => x.path.localeCompare(y.path));
      expect(aEntries.map((e) => e.path)).toEqual(["a1.md", "raw/a2.jsonl"]);
      expect(aEntries[0]?.content).toBe("A1 content\n");
      expect(aEntries[1]?.content).toBe(`{"a":2}\n`);

      const bEntries = [];
      for await (const e of storeB.listLogs()) bEntries.push(e);
      expect(bEntries.map((e) => e.path)).toEqual(["b1.md"]);
    } finally {
      await storeA.dispose();
      await storeB.dispose();
    }
  });

  test("buildBackupDump prefers the store-supplied listLogs seam over a null logsDir", async () => {
    const { store } = await buildStore();
    try {
      await store.putLog("session.md", "hello dump\n");
      await store.putLog("raw/trace.jsonl", `{"ok":true}\n`);

      const dump = await buildBackupDump(store, null);
      const logFiles = dump.filter((f) => f.path.startsWith("logs/"));
      logFiles.sort((a, b) => a.path.localeCompare(b.path));
      expect(logFiles).toEqual([
        { path: "logs/raw/trace.jsonl", content: `{"ok":true}\n` },
        { path: "logs/session.md", content: "hello dump\n" },
      ]);
    } finally {
      await store.dispose();
    }
  });
});
