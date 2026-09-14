import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedgerStore, requireWorksetStore, resolveLedgerBackend } from "@cq/ledger";
import { dispatch, EXIT_USAGE, type DispatchIo } from "../src/main.js";
import { runMigrate, setLedgerBackend } from "../src/migrate.js";
import { useIsolatedXdgState, writeXdgConfig } from "./xdgFixture.js";

useIsolatedXdgState();
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cq-migrate-"));
  roots.push(root);
  await writeXdgConfig(root);
  return root;
}

function recordingIo(): DispatchIo & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    out: () => undefined,
    err: (line) => errors.push(line),
    confirm: { isTty: false, out: () => undefined, err: () => undefined, prompt: async () => "" },
  };
}

describe("cq migrate explicit remote destination [Behavioral-Progression Blackbox-GoodCommunication]", () => {
  it("requires --to remote and preserves source state and config", async () => {
    const root = await fixture();
    const source = await createLedgerStore(root);
    try {
      const milestone = await source.store.createMilestone({ title: "source" });
      const item = await source.store.createItem("tasks", milestone.id, {
        status: "planned",
        fields: { headline: "retained" },
      });
      const config = await readFile(join(root, "cq.toml"), "utf8");
      const io = recordingIo();
      expect((await dispatch(["migrate", "--cwd", root], io)).exitCode).toBe(EXIT_USAGE);
      expect(io.errors.join("\n")).toContain("requires --to remote");
      expect(source.store.fetchItem("tasks", item.id)).toEqual(item);
      expect(await readFile(join(root, "cq.toml"), "utf8")).toBe(config);
    } finally {
      await source.store.dispose();
    }
  });

  it("rejects missing and unknown destinations before reading malformed config", async () => {
    const root = await fixture();
    await writeFile(join(root, "cq.toml"), "invalid = [");
    for (const args of [[], ["--to", "unknown"]]) {
      const io = recordingIo();
      expect((await dispatch(["migrate", "--cwd", root, ...args], io)).exitCode).toBe(EXIT_USAGE);
      expect(io.errors.join("\n")).toContain("remote");
    }
    expect(await readFile(join(root, "cq.toml"), "utf8")).toBe("invalid = [");
  });

  it("requires explicit XDG source configuration", async () => {
    const root = await fixture();
    await writeFile(join(root, "cq.toml"), "");
    const io = recordingIo();
    expect((await dispatch(["migrate", "--cwd", root, "--to", "remote"], io)).exitCode).toBe(
      EXIT_USAGE,
    );
    expect(io.errors.join("\n")).toContain("must be explicit 'xdg'");
  });

  it("requires the remote origin before opening the source", async () => {
    const root = await fixture();
    const previous = process.env["CQ_LEDGER_SERVER_URL"];
    delete process.env["CQ_LEDGER_SERVER_URL"];
    try {
      const io = recordingIo();
      expect((await dispatch(["migrate", "--cwd", root, "--to", "remote"], io)).exitCode).toBe(
        EXIT_USAGE,
      );
      expect(io.errors.join("\n")).toContain("CQ_LEDGER_SERVER_URL");
      expect(resolveLedgerBackend(root).backend).toBe("xdg");
    } finally {
      if (previous === undefined) delete process.env["CQ_LEDGER_SERVER_URL"];
      else process.env["CQ_LEDGER_SERVER_URL"] = previous;
    }
  });

  it("updates only ledger destination keys and preserves other config", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nprojectId = "retained"\n[project]\nname = "unchanged"\n',
    );
    await setLedgerBackend(root, "remote", { serverUrl: "https://cq.example.com" });
    expect(await readFile(join(root, "cq.toml"), "utf8")).toBe(
      '[ledger]\nbackend = "remote"\n  serverUrl = "https://cq.example.com"\nprojectId = "retained"\n[project]\nname = "unchanged"\n',
    );
    expect(resolveLedgerBackend(root).backend).toBe("remote");
  });

  it("waits for an admitted mutation before accessing remote administration [D470]", async () => {
    const root = await fixture();
    const source = await createLedgerStore(root);
    const workset = requireWorksetStore(source.store);
    const admission = await workset.admitLedgerMutation({ kind: "generic-write", targets: ["tasks:T1"] });
    const previousUrl = process.env["CQ_LEDGER_SERVER_URL"];
    const previousToken = process.env["CQ_LEDGER_REMOTE_ADMIN_TOKEN"];
    process.env["CQ_LEDGER_SERVER_URL"] = "http://127.0.0.1:1";
    delete process.env["CQ_LEDGER_REMOTE_ADMIN_TOKEN"];
    let completed = false;
    const migration = runMigrate({ cwd: root, yes: false, to: "remote" }, recordingIo()).then(
      () => { completed = true; return null; },
      (error: unknown) => { completed = true; return error; },
    );
    try {
      const admissionDeadlineMs = Date.now() + 1000;
      while (!completed && !workset.exclusiveHeld() && Date.now() < admissionDeadlineMs) {
        await Bun.sleep(5);
      }
      expect(workset.exclusiveHeld()).toBe(true);
      expect(completed).toBe(false);
      expect(resolveLedgerBackend(root).backend).toBe("xdg");
    } finally {
      await admission.acknowledge();
      const error = await migration;
      const exclusiveHeld = workset.exclusiveHeld();
      if (previousUrl === undefined) delete process.env["CQ_LEDGER_SERVER_URL"];
      else process.env["CQ_LEDGER_SERVER_URL"] = previousUrl;
      if (previousToken === undefined) delete process.env["CQ_LEDGER_REMOTE_ADMIN_TOKEN"];
      else process.env["CQ_LEDGER_REMOTE_ADMIN_TOKEN"] = previousToken;
      await source.store.dispose();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("CQ_LEDGER_REMOTE_ADMIN_TOKEN");
      expect(exclusiveHeld).toBe(false);
      expect(resolveLedgerBackend(root).backend).toBe("xdg");
    }
  });
});
