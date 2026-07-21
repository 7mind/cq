/**
 * T579 — embedded ledger-tui smoke test against a `backend = 'postgres'`
 * cq.toml: `McpLedgerClient.embedded` resolves a live `PostgresLedgerStore`
 * (mirrors `embeddedCoherence.test.ts`'s xdg-backend coverage) and the real
 * `<App>` Ink component renders against it via `ink-testing-library` — no
 * FakeClient, no subprocess, no mock transport.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286, same gate as every other
 * postgres-*.test.ts): no live Postgres in this sandbox/CI by default, so
 * this file SKIPS cleanly offline and `bun run check` stays green.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app.js";
import { McpLedgerClient } from "../src/mcpClient.js";

const exec = promisify(execFile);
const PG_URL = process.env.CQ_TEST_PG_URL;
const dirs: string[] = [];
let prevPgUrlEnv: string | undefined;

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll a raw frame getter until it contains `substr`. */
async function waitForFrame(getFrame: () => string, substr: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (getFrame().includes(substr)) return;
    await tick(10);
  }
  throw new Error(`waitForFrame: '${substr}' never appeared; last frame:\n${getFrame()}`);
}

beforeAll(() => {
  prevPgUrlEnv = process.env["CQ_LEDGER_PG_URL"];
});

afterAll(async () => {
  if (prevPgUrlEnv === undefined) delete process.env["CQ_LEDGER_PG_URL"];
  else process.env["CQ_LEDGER_PG_URL"] = prevPgUrlEnv;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/** A throwaway initialised git repo (stable projectKey) with cq.toml selecting postgres. */
async function postgresRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cq-tui-embedded-pg-"));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), `# repo ${randomUUID()}\n`, "utf8");
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  await writeFile(path.join(dir, "cq.toml"), '[ledger]\nbackend = "postgres"\nbackup = "none"\n', "utf8");
  return dir;
}

if (PG_URL === undefined || PG_URL.length === 0) {
  describe.skip("embedded ledger-tui over backend='postgres' (T579)", () => {
    it("requires CQ_TEST_PG_URL", () => {});
  });
} else {
  describe("embedded ledger-tui over backend='postgres' (T579)", () => {
    let client: McpLedgerClient | undefined;

    afterEach(async () => {
      await client?.close();
      client = undefined;
    });

    it("McpLedgerClient.embedded resolves backend='postgres' with a live pg handle", async () => {
      process.env["CQ_LEDGER_PG_URL"] = PG_URL;
      const dir = await postgresRepo();
      client = await McpLedgerClient.embedded(dir);
      expect(client.embedded).not.toBeNull();
      expect(client.embedded?.resolved.backend).toBe("postgres");
      expect(client.embedded?.resolved.pg).toBeDefined();
      expect(client.embedded?.resolved.dbPath).toBeUndefined();
      expect(client.embedded?.resolved.store).toBe(client.embedded?.store);
    });

    it("<App> renders against the postgres-backed embedded store — lists the canonical ledgers", async () => {
      process.env["CQ_LEDGER_PG_URL"] = PG_URL;
      const dir = await postgresRepo();
      client = await McpLedgerClient.embedded(dir);

      const r = render(React.createElement(App, { client }));
      try {
        await waitForFrame(() => r.lastFrame() ?? "", "tasks");
        const frame = r.lastFrame() ?? "";
        expect(frame).toContain("milestones");
        expect(frame).not.toContain("connecting");
      } finally {
        r.unmount();
      }
    });

    it("<App> creates an item through the postgres store and shows it in the list", async () => {
      process.env["CQ_LEDGER_PG_URL"] = PG_URL;
      const dir = await postgresRepo();
      client = await McpLedgerClient.embedded(dir);
      const store = client.embedded?.store;
      if (store === undefined) throw new Error("expected an embedded store");

      const milestone = await store.createMilestone({ title: "T579 tui pg smoke" });
      await store.createItem("tasks", milestone.id, {
        status: "planned",
        fields: { headline: "pg-backed tui item" },
      });

      const r = render(React.createElement(App, { client }));
      try {
        await waitForFrame(() => r.lastFrame() ?? "", "tasks");
        // The ledgers list is alphabetical; step DOWN until "tasks" is the
        // highlighted row (rendered "› tasks") rather than assume a fixed
        // position.
        const end = Date.now() + 4000;
        while (!(r.lastFrame() ?? "").includes("› tasks") && Date.now() < end) {
          r.stdin.write("[B"); // DOWN
          await tick(30);
        }
        expect(r.lastFrame() ?? "").toContain("› tasks");
        r.stdin.write("\r"); // ENTER — open the highlighted "tasks" ledger
        await waitForFrame(() => r.lastFrame() ?? "", "pg-backed tui item");
      } finally {
        r.unmount();
      }
    });
  });
}
