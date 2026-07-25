import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  InMemoryLedgerStore,
  MILESTONES_AMBIENT_ID,
  TASKS_LEDGER,
  type LedgerSchema,
  type LedgerStore,
  type ReadLogResult,
} from "../src/index.js";
import type { OnMutation } from "../src/store/LedgerStore.js";
import { SqliteLedgerStore } from "../src/store/sqlite/SqliteLedgerStore.js";
import {
  XdgProjectRuntimeLocationError,
  openXdgProjectRuntime,
} from "../src/store/sqlite/xdgProjectRuntime.js";
import {
  type AbstractStoreFactory,
  runStoreAbstractSuite,
} from "./store-abstract.js";

const cleanupPaths: string[] = [];
const PROJECT_KEY = "runtime-project";

afterAll(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((candidate) =>
      rm(candidate, { recursive: true, force: true }),
    ),
  );
});

interface RuntimeStore extends LedgerStore {
  readLog(relPath: string): Promise<ReadLogResult>;
}

interface ContractRuntime {
  readonly projectKey: string;
  readonly dbPath: string;
  readonly logsDir: string;
  readonly store: RuntimeStore;
  dispose(): Promise<void>;
}

interface RuntimeFixture {
  readonly root: string;
  prepare(
    key: string,
    seed: ReadonlyArray<{ name: string; schema: LedgerSchema }>,
  ): Promise<void>;
  seedLog(key: string, relPath: string, content: string): Promise<void>;
  makeUnreadable(key: string): Promise<void>;
  makeProjectSymlink(key: string): Promise<void>;
  installRedirectingConfig(key: string, redirectKey: string): Promise<void>;
  backendArtifactExists(key: string): Promise<boolean>;
  open(key: string, onMutation?: OnMutation): Promise<ContractRuntime>;
}

interface RuntimeContractFactory {
  readonly name: string;
  build(): Promise<RuntimeFixture>;
}

type DummyProject = {
  readonly seed: ReadonlyArray<{ name: string; schema: LedgerSchema }>;
  readonly logs: Map<string, string>;
  state: "valid" | "unreadable" | "symlink";
};

class StrictRuntimeDummyStore extends InMemoryLedgerStore implements RuntimeStore {
  constructor(
    seed: ReadonlyArray<{ name: string; schema: LedgerSchema }>,
    onMutation: OnMutation | undefined,
    private readonly logs: Map<string, string>,
  ) {
    super({
      seed: [...seed],
      ...(onMutation === undefined ? {} : { onMutation }),
    });
  }

  async readLog(relPath: string): Promise<ReadLogResult> {
    if (path.isAbsolute(relPath)) throw new Error("read_log: absolute paths are not allowed");
    const rel = relPath.replace(/^\.cq[/\\]logs[/\\]/, "");
    const normalized = path.posix.normalize(rel.replaceAll("\\", "/"));
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new Error("read_log: path escapes logs root");
    }
    const content = this.logs.get(normalized);
    if (content === undefined) throw new Error(`ENOENT: ${relPath}`);
    return { path: relPath, content };
  }
}

class StrictInMemoryRuntimeFactory {
  readonly root = "/strict-dummy/projects";
  private readonly projects = new Map<string, DummyProject>();

  async prepare(
    key: string,
    seed: ReadonlyArray<{ name: string; schema: LedgerSchema }>,
  ): Promise<void> {
    this.projects.set(key, { seed, logs: new Map(), state: "valid" });
  }

  async seedLog(key: string, relPath: string, content: string): Promise<void> {
    const project = this.requireProject(key);
    project.logs.set(relPath, content);
  }

  async makeUnreadable(key: string): Promise<void> {
    this.requireProject(key).state = "unreadable";
  }

  async makeProjectSymlink(key: string): Promise<void> {
    this.projects.set(key, { seed: [], logs: new Map(), state: "symlink" });
  }

  async installRedirectingConfig(_key: string, _redirectKey: string): Promise<void> {}

  async backendArtifactExists(_key: string): Promise<boolean> {
    return false;
  }

  async open(key: string, onMutation?: OnMutation): Promise<ContractRuntime> {
    this.assertSafeKey(key);
    const project = this.projects.get(key);
    if (project === undefined) {
      throw new XdgProjectRuntimeLocationError(`project does not exist: ${key}`);
    }
    if (project.state !== "valid") {
      throw new XdgProjectRuntimeLocationError(`project cannot be opened: ${key}`);
    }
    const store = new StrictRuntimeDummyStore(project.seed, onMutation, project.logs);
    await store.init();
    let disposal: Promise<void> | null = null;
    return {
      projectKey: key,
      dbPath: path.join(this.root, key, "state", "ledger.db"),
      logsDir: path.join(this.root, key, "logs"),
      store,
      dispose() {
        disposal ??= store.dispose();
        return disposal;
      },
    };
  }

  private requireProject(key: string): DummyProject {
    const project = this.projects.get(key);
    if (project === undefined) throw new Error(`dummy project missing: ${key}`);
    return project;
  }

  private assertSafeKey(key: string): void {
    if (
      key.trim() === "" ||
      key === "." ||
      key === ".." ||
      path.isAbsolute(key) ||
      key.includes("/") ||
      key.includes("\\") ||
      key.includes("\0")
    ) {
      throw new XdgProjectRuntimeLocationError(`invalid project key: ${key}`);
    }
  }
}

async function freshProjectsRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(root);
  return root;
}

class RealRuntimeFixture implements RuntimeFixture {
  constructor(readonly root: string) {}

  async prepare(
    key: string,
    seed: ReadonlyArray<{ name: string; schema: LedgerSchema }>,
  ): Promise<void> {
    const stateDir = path.join(this.root, key, "state");
    await mkdir(stateDir, { recursive: true });
    const store = new SqliteLedgerStore({
      dbPath: path.join(stateDir, "ledger.db"),
      logsDir: path.join(this.root, key, "logs"),
    });
    await store.init();
    try {
      for (const entry of seed) {
        await store.createLedger(entry.name, entry.schema);
      }
    } finally {
      await store.dispose();
    }
  }

  async seedLog(key: string, relPath: string, content: string): Promise<void> {
    const logsDir = path.join(this.root, key, "logs");
    await mkdir(path.dirname(path.join(logsDir, relPath)), { recursive: true });
    await writeFile(path.join(logsDir, relPath), content);
  }

  async makeUnreadable(key: string): Promise<void> {
    await writeFile(path.join(this.root, key, "state", "ledger.db"), "not sqlite");
  }

  async makeProjectSymlink(key: string): Promise<void> {
    const outsideRoot = await freshProjectsRoot("t832-symlink-target-");
    const outside = new RealRuntimeFixture(outsideRoot);
    await outside.prepare("target", []);
    await symlink(path.join(outsideRoot, "target"), path.join(this.root, key), "dir");
  }

  async installRedirectingConfig(key: string, redirectKey: string): Promise<void> {
    await writeFile(
      path.join(this.root, key, "cq.toml"),
      `[ledger]\nbackend = "fs"\nprojectId = "${redirectKey}"\n`,
    );
  }

  async backendArtifactExists(key: string): Promise<boolean> {
    try {
      await lstat(path.join(this.root, key, ".cq"));
      return true;
    } catch {
      return false;
    }
  }

  async open(key: string, onMutation?: OnMutation): Promise<ContractRuntime> {
    const runtime = await openXdgProjectRuntime({
      projectsRoot: this.root,
      projectKey: key,
      ...(onMutation === undefined ? {} : { onMutation }),
    });
    return runtime;
  }
}

const dummyFactory: RuntimeContractFactory = {
  name: "strict hand-written in-memory dummy (Behavioral-Active Blackbox-Atomic)",
  async build() {
    const dummy = new StrictInMemoryRuntimeFactory();
    return {
      root: dummy.root,
      prepare: (key, seed) => dummy.prepare(key, seed),
      seedLog: (key, relPath, content) => dummy.seedLog(key, relPath, content),
      makeUnreadable: (key) => dummy.makeUnreadable(key),
      makeProjectSymlink: (key) => dummy.makeProjectSymlink(key),
      installRedirectingConfig: (key, redirectKey) =>
        dummy.installRedirectingConfig(key, redirectKey),
      backendArtifactExists: (key) => dummy.backendArtifactExists(key),
      open: (key, onMutation) => dummy.open(key, onMutation),
    };
  },
};

const realFactory: RuntimeContractFactory = {
  name: "real temporary XDG/SQLite adapter (Behavioral-Active Blackbox-GoodCommunication)",
  async build() {
    return new RealRuntimeFixture(await freshProjectsRoot("t832-projects-"));
  },
};

function runtimeStoreFactory(factory: RuntimeContractFactory): AbstractStoreFactory {
  const runtimes = new WeakMap<LedgerStore, ContractRuntime>();
  const build = async (
    seed: Array<{ name: string; schema: LedgerSchema }>,
    onMutation?: OnMutation,
  ): Promise<LedgerStore> => {
    const fixture = await factory.build();
    await fixture.prepare(PROJECT_KEY, seed);
    const runtime = await fixture.open(PROJECT_KEY, onMutation);
    runtimes.set(runtime.store, runtime);
    return runtime.store;
  };
  return {
    name: `T832 runtime — ${factory.name}`,
    timeoutMs: factory === realFactory ? 20_000 : 10_000,
    build: (seed) => build(seed),
    buildWithHook: (seed, onMutation) => build(seed, onMutation),
    async teardown(store) {
      const runtime = runtimes.get(store);
      if (runtime === undefined) throw new Error("runtime teardown lost ownership");
      await runtime.dispose();
    },
  };
}

function runRuntimeContract(factory: RuntimeContractFactory): void {
  describe(`explicit XDG runtime contract — ${factory.name}`, () => {
    test("derives only the selected DB/log paths, reads logs, and disposes idempotently", async () => {
      const fixture = await factory.build();
      await fixture.prepare("alpha", []);
      await fixture.seedLog("alpha", "raw/session.jsonl", '{"ok":true}\n');
      const runtime = await fixture.open("alpha");
      expect(runtime.projectKey).toBe("alpha");
      expect(runtime.dbPath).toBe(path.join(fixture.root, "alpha", "state", "ledger.db"));
      expect(runtime.logsDir).toBe(path.join(fixture.root, "alpha", "logs"));
      expect(await runtime.store.readLog(".cq/logs/raw/session.jsonl")).toEqual({
        path: ".cq/logs/raw/session.jsonl",
        content: '{"ok":true}\n',
      });

      await runtime.dispose();
      await runtime.dispose();
      expect(() => runtime.store.enumerate()).toThrow(/initiali[sz]ed/);
    });

    test("keeps mutations, counters, search, and logs isolated between two keys", async () => {
      const fixture = await factory.build();
      await fixture.prepare("alpha", []);
      await fixture.prepare("beta", []);
      await fixture.seedLog("alpha", "session.md", "alpha log");
      await fixture.seedLog("beta", "session.md", "beta log");
      const alpha = await fixture.open("alpha");
      const beta = await fixture.open("beta");
      try {
        const item = await alpha.store.createItem(
          TASKS_LEDGER,
          MILESTONES_AMBIENT_ID,
          {
            status: "planned",
            fields: { headline: "alpha-only searchable item" },
          },
        );
        expect(item.id).toBe("T1");
        expect(alpha.store.fetch(TASKS_LEDGER).counters.item).toBe(1);
        expect(beta.store.fetch(TASKS_LEDGER).counters.item).toBe(0);
        expect(alpha.store.search(TASKS_LEDGER, "alpha-only")).toHaveLength(1);
        expect(beta.store.search(TASKS_LEDGER, "alpha-only")).toEqual([]);
        expect(await alpha.store.ftsSearch("searchable")).toHaveLength(1);
        expect(await beta.store.ftsSearch("searchable")).toEqual([]);
        expect((await alpha.store.readLog("session.md")).content).toBe("alpha log");
        expect((await beta.store.readLog("session.md")).content).toBe("beta log");
      } finally {
        await alpha.dispose();
        await beta.dispose();
      }
    });

    test("rejects missing, unreadable, symlinked, and path-escaping selections", async () => {
      const fixture = await factory.build();
      await expect(fixture.open("missing")).rejects.toThrow(
        XdgProjectRuntimeLocationError,
      );
      for (const key of ["", ".", "..", "../escape", "nested/key", "nested\\key", "/absolute"]) {
        await expect(fixture.open(key)).rejects.toThrow(
          XdgProjectRuntimeLocationError,
        );
      }

      await fixture.prepare("unreadable", []);
      await fixture.makeUnreadable("unreadable");
      await expect(fixture.open("unreadable")).rejects.toThrow(
        XdgProjectRuntimeLocationError,
      );

      await fixture.makeProjectSymlink("linked");
      await expect(fixture.open("linked")).rejects.toThrow(
        XdgProjectRuntimeLocationError,
      );
    });

    test("ignores repository backend configuration and stays on the selected key", async () => {
      const fixture = await factory.build();
      await fixture.prepare("selected", []);
      await fixture.prepare("redirect-target", []);
      await fixture.installRedirectingConfig("selected", "redirect-target");
      const selected = await fixture.open("selected");
      const redirectTarget = await fixture.open("redirect-target");
      try {
        const created = await selected.store.createMilestone({ title: "selected only" });
        expect(created.id).toBe("M1");
        expect(() => redirectTarget.store.fetchItem("milestones", "M1")).toThrow();
        expect(await fixture.backendArtifactExists("selected")).toBe(false);
      } finally {
        await selected.dispose();
        await redirectTarget.dispose();
      }
    });
  });
}

runStoreAbstractSuite(runtimeStoreFactory(dummyFactory));
runStoreAbstractSuite(runtimeStoreFactory(realFactory));
runRuntimeContract(dummyFactory);
runRuntimeContract(realFactory);

describe("explicit XDG runtime filesystem boundaries", () => {
  test("corrupt DB rejection preserves bytes and creates no SQLite sidecars", async () => {
    const fixture = new RealRuntimeFixture(await freshProjectsRoot("t832-corrupt-"));
    await fixture.prepare("corrupt", []);
    await fixture.makeUnreadable("corrupt");
    const stateDir = path.join(fixture.root, "corrupt", "state");
    const dbPath = path.join(stateDir, "ledger.db");
    const before = await readFile(dbPath);
    const beforeNames = (await readdir(stateDir)).sort();

    await expect(fixture.open("corrupt")).rejects.toThrow(
      XdgProjectRuntimeLocationError,
    );
    expect(await readFile(dbPath)).toEqual(before);
    expect((await readdir(stateDir)).sort()).toEqual(beforeNames);
  });

  test("traversal and project symlinks do not mutate their outside targets", async () => {
    const fixture = new RealRuntimeFixture(await freshProjectsRoot("t832-escape-"));
    const outsideDir = await freshProjectsRoot("t832-outside-");
    const sentinel = path.join(outsideDir, "sentinel");
    await writeFile(sentinel, "unchanged");
    const beforeHash = createHash("sha256").update(await readFile(sentinel)).digest("hex");

    await expect(fixture.open(`../${path.basename(outsideDir)}`)).rejects.toThrow(
      XdgProjectRuntimeLocationError,
    );
    await fixture.makeProjectSymlink("linked");
    await expect(fixture.open("linked")).rejects.toThrow(
      XdgProjectRuntimeLocationError,
    );
    expect(createHash("sha256").update(await readFile(sentinel)).digest("hex")).toBe(
      beforeHash,
    );
  });

  test("rejects state, database, and logs symlink escapes before opening", async () => {
    const fixture = new RealRuntimeFixture(await freshProjectsRoot("t832-sidecars-"));
    const outside = await freshProjectsRoot("t832-sidecars-outside-");

    await mkdir(path.join(fixture.root, "state-link"), { recursive: true });
    await mkdir(path.join(outside, "state"), { recursive: true });
    await symlink(
      path.join(outside, "state"),
      path.join(fixture.root, "state-link", "state"),
      "dir",
    );
    await expect(fixture.open("state-link")).rejects.toThrow(
      XdgProjectRuntimeLocationError,
    );

    await mkdir(path.join(fixture.root, "db-link", "state"), { recursive: true });
    const outsideDb = path.join(outside, "ledger.db");
    await writeFile(outsideDb, "outside");
    await symlink(
      outsideDb,
      path.join(fixture.root, "db-link", "state", "ledger.db"),
      "file",
    );
    await expect(fixture.open("db-link")).rejects.toThrow(
      XdgProjectRuntimeLocationError,
    );

    await fixture.prepare("logs-link", []);
    await mkdir(path.join(outside, "logs"), { recursive: true });
    await symlink(
      path.join(outside, "logs"),
      path.join(fixture.root, "logs-link", "logs"),
      "dir",
    );
    await expect(fixture.open("logs-link")).rejects.toThrow(
      XdgProjectRuntimeLocationError,
    );
  });
});
