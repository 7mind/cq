import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createLedgerStore,
  ensureSchema,
  MILESTONES_LEDGER,
  openPgPool,
  RemoteLedgerClient,
  resolveLogsDir,
  resolveStateDir,
  SqliteLedgerStore,
  TASKS_LEDGER,
  XDG_DB_FILENAME,
} from "@cq/ledger";
import { serveHub } from "@cq/ledger-web/hub";
import { dispatch, EXIT_USAGE } from "../src/main.js";

const PG_URL = process.env["CQ_TEST_PG_URL"];
const ORDINARY_TOKEN = "t4405-ordinary";
const ADMIN_TOKEN = "t4405-admin";

function io(stdin = "") {
  const outs: string[] = [];
  const errs: string[] = [];
  return {
    outs,
    errs,
    out: (line: string) => outs.push(line),
    err: (line: string) => errs.push(line),
    confirm: {
      isTty: false,
      out: () => undefined,
      err: () => undefined,
      prompt: async () => "",
    },
    readStdin: async () => stdin,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("cq migrate --to postgres is retired (T736)", () => {
  it("refuses the public postgres target", async () => {
    const errs: string[] = [];
    const outcome = await dispatch(["migrate", "--to", "postgres"], {
      out: () => undefined,
      err: (line) => errs.push(line),
      confirm: {
        isTty: false,
        out: () => undefined,
        err: () => undefined,
        prompt: async () => "",
      },
    });
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(errs.join("\n")).toMatch(/remote|--to postgres|retired/i);
  });
});

describe.skipIf(PG_URL === undefined || PG_URL.trim() === "")(
  "cq migrate --to remote over live PostgreSQL",
  () => {
    it("migrates a fresh unregistered xdg tenant through cq serve into postgres [Good-Communication]", async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), "cq-migrate-remote-root-"));
      const xdgStateHome = await fs.mkdtemp(path.join(tmpdir(), "cq-migrate-remote-xdg-"));
      const outdir = await fs.mkdtemp(path.join(tmpdir(), "cq-migrate-remote-web-"));
      const projectKey = `t4405-${randomUUID()}`;
      const logPath = "20260901-remote-migration.md";
      const logBody = "# remote migration regression\n";
      const oldXdgStateHome = process.env["XDG_STATE_HOME"];
      const oldServerUrl = process.env["CQ_LEDGER_SERVER_URL"];
      const oldRemoteToken = process.env["CQ_LEDGER_REMOTE_TOKEN"];
      const oldAdminToken = process.env["CQ_LEDGER_REMOTE_ADMIN_TOKEN"];
      let server: ReturnType<typeof Bun.serve> | null = null;
      let pool: ReturnType<typeof openPgPool> | null = null;
      let ordinary: RemoteLedgerClient | null = null;
      let admin: RemoteLedgerClient | null = null;
      try {
        process.env["XDG_STATE_HOME"] = xdgStateHome;
        await fs.writeFile(
          path.join(root, "cq.toml"),
          `[ledger]\nbackend = "xdg"\nprojectId = "${projectKey}"\nbackup = "in-tree"\n`,
          "utf8",
        );

        const source = await createLedgerStore(root);
        const activeMilestone = await source.store.createMilestone({ title: "active migration" });
        const activeTask = await source.store.createItem(TASKS_LEDGER, activeMilestone.id, {
          status: "planned",
          fields: { headline: "migrate me" },
        });
        const archivedMilestone = await source.store.createMilestone({ title: "archived migration" });
        const archivedTask = await source.store.createItem(TASKS_LEDGER, archivedMilestone.id, {
          status: "planned",
          fields: { headline: "archive me" },
        });
        await source.store.updateItem(TASKS_LEDGER, archivedTask.id, { status: "done" });
        await source.store.updateMilestone(archivedMilestone.id, { status: "done" });
        await source.store.archiveMilestone(archivedMilestone.id, "remote migration fixture");
        source.backup?.close();
        await source.store.dispose();

        const logResult = await dispatch(
          ["log", "put", "--stdin", "--dest", `logs/${logPath}`, "--cwd", root],
          io(logBody),
        );
        expect(logResult.exitCode).toBe(0);

        pool = openPgPool(PG_URL!);
        await ensureSchema(pool);
        const indexPath = path.join(outdir, "index.html");
        await fs.writeFile(indexPath, "<!doctype html>\n", "utf8");
        server = serveHub(
          {
            host: "127.0.0.1",
            port: 0,
            token: ORDINARY_TOKEN,
            managementToken: null,
            adminToken: ADMIN_TOKEN,
            outdir,
          },
          pool,
          indexPath,
        );
        const serverUrl = `http://127.0.0.1:${String(server.port)}`;
        process.env["CQ_LEDGER_SERVER_URL"] = serverUrl;
        process.env["CQ_LEDGER_REMOTE_TOKEN"] = ORDINARY_TOKEN;
        process.env["CQ_LEDGER_REMOTE_ADMIN_TOKEN"] = ADMIN_TOKEN;

        const migrationIo = io();
        const outcome = await dispatch(
          ["migrate", "--cwd", root, "--to", "remote"],
          migrationIo,
        );
        expect(outcome.exitCode).toBe(0);
        expect(migrationIo.errs).toEqual([]);
        expect(await fs.readFile(path.join(root, "cq.toml"), "utf8")).toContain(
          'backend = "remote"',
        );

        ordinary = await RemoteLedgerClient.connect({
          serverUrl,
          projectKey,
          token: ORDINARY_TOKEN,
        });
        expect((await ordinary.fetchItem(TASKS_LEDGER, activeTask.id, "full")).fields["headline"]).toBe(
          "migrate me",
        );
        const taskArchive = await ordinary.fetchLedgerArchive(
          TASKS_LEDGER,
          archivedMilestone.id,
        );
        expect(taskArchive.kind).toBe("group");
        if (taskArchive.kind === "group") {
          expect(taskArchive.milestone.items[0]?.id).toBe(archivedTask.id);
        }
        const milestoneArchive = await ordinary.fetchLedgerArchive(
          MILESTONES_LEDGER,
          archivedMilestone.id,
        );
        expect(milestoneArchive.kind).toBe("item");
        if (milestoneArchive.kind === "item") {
          expect(milestoneArchive.item.id).toBe(archivedMilestone.id);
        }
        expect((await ordinary.readLog(logPath)).content).toBe(logBody);

        const sourceProbe = new SqliteLedgerStore({
          dbPath: path.join(resolveStateDir(projectKey), XDG_DB_FILENAME),
          logsDir: resolveLogsDir(projectKey),
        });
        await sourceProbe.init();
        try {
          expect(sourceProbe.fetchItem(TASKS_LEDGER, activeTask.id).fields["headline"]).toBe(
            "migrate me",
          );
          expect((await sourceProbe.readLog(logPath)).content).toBe(logBody);
        } finally {
          await sourceProbe.dispose();
        }

        const backupIo = io();
        expect((await dispatch(["backup", "--cwd", root], backupIo)).exitCode).toBe(0);
        expect(backupIo.errs).toEqual([]);
        expect(await fs.readFile(path.join(root, ".cq", `${TASKS_LEDGER}.md`), "utf8")).toContain(
          "migrate me",
        );

        await ordinary.updateItem(TASKS_LEDGER, activeTask.id, {
          fields: { headline: "mutated after backup" },
        });
        expect((await ordinary.fetchItem(TASKS_LEDGER, activeTask.id, "full")).fields["headline"]).toBe(
          "mutated after backup",
        );
        const resetIo = io();
        expect((await dispatch(["reset", "--cwd", root, "--yes"], resetIo)).exitCode).toBe(0);
        expect(resetIo.errs).toEqual([]);
        await expect(ordinary.fetchItem(TASKS_LEDGER, activeTask.id, "full")).rejects.toThrow();

        const restoreIo = io();
        expect(
          (await dispatch(["restore", "--cwd", root, "--yes"], restoreIo)).exitCode,
        ).toBe(0);
        expect(restoreIo.errs).toEqual([]);
        expect((await ordinary.fetchItem(TASKS_LEDGER, activeTask.id, "full")).fields["headline"]).toBe(
          "migrate me",
        );
        expect((await ordinary.readLog(logPath)).content).toBe(logBody);

        admin = await RemoteLedgerClient.connectAdmin({ serverUrl, projectKey, adminToken: ADMIN_TOKEN });
        const exported = await admin.exportDump(`export-${randomUUID()}`);
        await expect(
          admin.importDump(`import-${randomUUID()}`, "migrate-empty", exported),
        ).rejects.toThrow(/not empty/i);
        await admin.close();
        admin = null;
        await ordinary.close();
        ordinary = null;
        const eraseIo = io();
        expect((await dispatch(["erase", "--cwd", root, "--yes"], eraseIo)).exitCode).toBe(0);
        expect(eraseIo.errs).toEqual([]);
        const projectsResponse = await fetch(`${serverUrl}/api/projects`, {
          headers: { authorization: `Bearer ${ORDINARY_TOKEN}` },
        });
        expect(projectsResponse.status).toBe(200);
        const projects = (await projectsResponse.json()) as {
          projects: Array<{ key: string }>;
        };
        expect(projects.projects.some(({ key }) => key === projectKey)).toBe(false);
      } finally {
        if (ordinary !== null) await ordinary.close().catch(() => undefined);
        if (admin !== null) await admin.close().catch(() => undefined);
        if (server !== null) await server.stop(true);
        if (pool !== null) await pool.close();
        restoreEnv("XDG_STATE_HOME", oldXdgStateHome);
        restoreEnv("CQ_LEDGER_SERVER_URL", oldServerUrl);
        restoreEnv("CQ_LEDGER_REMOTE_TOKEN", oldRemoteToken);
        restoreEnv("CQ_LEDGER_REMOTE_ADMIN_TOKEN", oldAdminToken);
        await Promise.all(
          [root, xdgStateHome, outdir].map((dir) =>
            fs.rm(dir, { recursive: true, force: true }),
          ),
        );
      }
    }, 60_000);
  },
);
