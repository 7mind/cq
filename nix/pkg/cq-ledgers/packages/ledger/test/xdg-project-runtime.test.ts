import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
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
  readonly repositoryRoot: string;
  prepare(
    key: string,
    seed: ReadonlyArray<{ name: string; schema: LedgerSchema }>,
  ): Promise<void>;
  seedLog(key: string, relPath: string, content: string): Promise<void>;
  makeCorrupt(key: string): Promise<void>;
  makeProjectSymlink(key: string): Promise<void>;
  installRedirectingConfig(redirectKey: string): Promise<string>;
  repositoryBackendArtifactExists(): Promise<boolean>;
  open(key: string, onMutation?: OnMutation): Promise<ContractRuntime>;
  openAt(
    projectsRoot: string,
    key: string,
    onMutation?: OnMutation,
  ): Promise<ContractRuntime>;
  openFromRepository(
    key: string,
    onMutation?: OnMutation,
  ): Promise<ContractRuntime>;
}

interface RuntimeContractFactory {
  readonly name: string;
  build(): Promise<RuntimeFixture>;
}

type DummyProject = {
  readonly seed: ReadonlyArray<{ name: string; schema: LedgerSchema }>;
  readonly logs: Map<string, string>;
  state: "valid" | "corrupt" | "symlink";
  store: StrictRuntimeDummyStore | null;
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
  readonly repositoryRoot = "/strict-dummy/repository";
  private readonly projects = new Map<string, DummyProject>();

  async prepare(
    key: string,
    seed: ReadonlyArray<{ name: string; schema: LedgerSchema }>,
  ): Promise<void> {
    this.projects.set(key, {
      seed,
      logs: new Map(),
      state: "valid",
      store: null,
    });
  }

  async seedLog(key: string, relPath: string, content: string): Promise<void> {
    const project = this.requireProject(key);
    project.logs.set(relPath, content);
  }

  async makeCorrupt(key: string): Promise<void> {
    this.requireProject(key).state = "corrupt";
  }

  async makeProjectSymlink(key: string): Promise<void> {
    this.projects.set(key, {
      seed: [],
      logs: new Map(),
      state: "symlink",
      store: null,
    });
  }

  async installRedirectingConfig(_redirectKey: string): Promise<string> {
    return path.join(this.repositoryRoot, "cq.toml");
  }

  async repositoryBackendArtifactExists(): Promise<boolean> {
    return false;
  }

  async open(key: string, onMutation?: OnMutation): Promise<ContractRuntime> {
    return this.openAt(this.root, key, onMutation);
  }

  async openAt(
    projectsRoot: string,
    key: string,
    onMutation?: OnMutation,
  ): Promise<ContractRuntime> {
    if (!path.isAbsolute(projectsRoot)) {
      throw new XdgProjectRuntimeLocationError(
        `projectsRoot must be absolute: ${projectsRoot}`,
      );
    }
    this.assertSafeKey(key);
    if (projectsRoot !== this.root) {
      throw new XdgProjectRuntimeLocationError(
        `projects root does not exist: ${projectsRoot}`,
      );
    }
    const project = this.projects.get(key);
    if (project === undefined) {
      throw new XdgProjectRuntimeLocationError(`project does not exist: ${key}`);
    }
    if (project.state !== "valid") {
      throw new XdgProjectRuntimeLocationError(`project cannot be opened: ${key}`);
    }
    if (project.store === null) {
      project.store = new StrictRuntimeDummyStore(
        project.seed,
        onMutation,
        project.logs,
      );
      await project.store.init();
    }
    const store = runtimeStoreSession(project.store);
    let disposal: Promise<void> | null = null;
    return {
      projectKey: key,
      dbPath: path.join(projectsRoot, key, "state", "ledger.db"),
      logsDir: path.join(projectsRoot, key, "logs"),
      store,
      dispose() {
        disposal ??= store.dispose();
        return disposal;
      },
    };
  }

  async openFromRepository(
    key: string,
    onMutation?: OnMutation,
  ): Promise<ContractRuntime> {
    return this.open(key, onMutation);
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

function runtimeStoreSession(store: StrictRuntimeDummyStore): RuntimeStore {
  let disposed = false;
  return new Proxy(store, {
    get(target, property) {
      if (property === "dispose") {
        return async () => {
          disposed = true;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (disposed) {
          throw new Error("InMemoryLedgerStore is not initialized");
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

async function freshProjectsRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(root);
  return root;
}

class RealRuntimeFixture implements RuntimeFixture {
  constructor(
    readonly root: string,
    readonly repositoryRoot: string,
  ) {}

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

  async makeCorrupt(key: string): Promise<void> {
    await writeFile(path.join(this.root, key, "state", "ledger.db"), "not sqlite");
  }

  async makeProjectSymlink(key: string): Promise<void> {
    const outsideRoot = await freshProjectsRoot("t832-symlink-target-");
    const outside = new RealRuntimeFixture(outsideRoot, this.repositoryRoot);
    await outside.prepare("target", []);
    await symlink(path.join(outsideRoot, "target"), path.join(this.root, key), "dir");
  }

  async installRedirectingConfig(redirectKey: string): Promise<string> {
    const configPath = path.join(this.repositoryRoot, "cq.toml");
    await writeFile(
      configPath,
      `[ledger]\nbackend = "fs"\nprojectId = "${redirectKey}"\n`,
    );
    return configPath;
  }

  async repositoryBackendArtifactExists(): Promise<boolean> {
    try {
      await lstat(path.join(this.repositoryRoot, ".cq"));
      return true;
    } catch {
      return false;
    }
  }

  async open(key: string, onMutation?: OnMutation): Promise<ContractRuntime> {
    return this.openAt(this.root, key, onMutation);
  }

  async openAt(
    projectsRoot: string,
    key: string,
    onMutation?: OnMutation,
  ): Promise<ContractRuntime> {
    const runtime = await openXdgProjectRuntime({
      projectsRoot,
      projectKey: key,
      ...(onMutation === undefined ? {} : { onMutation }),
    });
    return runtime;
  }

  async openFromRepository(
    key: string,
    onMutation?: OnMutation,
  ): Promise<ContractRuntime> {
    const previousCwd = process.cwd();
    process.chdir(this.repositoryRoot);
    try {
      return await this.open(key, onMutation);
    } finally {
      process.chdir(previousCwd);
    }
  }
}

const dummyFactory: RuntimeContractFactory = {
  name: "strict hand-written in-memory dummy (Behavioral-Active Blackbox-Atomic)",
  async build() {
    const dummy = new StrictInMemoryRuntimeFactory();
    return {
      root: dummy.root,
      repositoryRoot: dummy.repositoryRoot,
      prepare: (key, seed) => dummy.prepare(key, seed),
      seedLog: (key, relPath, content) => dummy.seedLog(key, relPath, content),
      makeCorrupt: (key) => dummy.makeCorrupt(key),
      makeProjectSymlink: (key) => dummy.makeProjectSymlink(key),
      installRedirectingConfig: (redirectKey) =>
        dummy.installRedirectingConfig(redirectKey),
      repositoryBackendArtifactExists: () =>
        dummy.repositoryBackendArtifactExists(),
      open: (key, onMutation) => dummy.open(key, onMutation),
      openAt: (projectsRoot, key, onMutation) =>
        dummy.openAt(projectsRoot, key, onMutation),
      openFromRepository: (key, onMutation) =>
        dummy.openFromRepository(key, onMutation),
    };
  },
};

const realFactory: RuntimeContractFactory = {
  name: "real temporary XDG/SQLite adapter (Behavioral-Active Blackbox-GoodCommunication)",
  async build(): Promise<RealRuntimeFixture> {
    return new RealRuntimeFixture(
      await freshProjectsRoot("t832-projects-"),
      await freshProjectsRoot("t832-repository-"),
    );
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

    test("persists mutations and counters across disposal and reopen", async () => {
      const fixture = await factory.build();
      await fixture.prepare("alpha", []);
      const first = await fixture.open("alpha");
      const milestone = await first.store.createMilestone({
        title: "durable milestone",
      });
      const firstItem = await first.store.createItem(TASKS_LEDGER, milestone.id, {
        status: "planned",
        fields: { headline: "durable searchable item" },
      });
      expect(firstItem.id).toBe("T1");
      await first.dispose();

      const reopened = await fixture.open("alpha");
      try {
        expect(reopened.store.fetchItem("milestones", milestone.id).fields.title).toBe(
          "durable milestone",
        );
        expect(reopened.store.search(TASKS_LEDGER, "durable searchable")).toHaveLength(
          1,
        );
        const secondItem = await reopened.store.createItem(
          TASKS_LEDGER,
          milestone.id,
          {
            status: "planned",
            fields: { headline: "second durable item" },
          },
        );
        expect(secondItem.id).toBe("T2");
        expect(reopened.store.fetch(TASKS_LEDGER).counters.item).toBe(2);
        expect(() => first.store.enumerate()).toThrow(/initiali[sz]ed/);
      } finally {
        await reopened.dispose();
      }
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
      await expect(fixture.openAt("relative/projects", "missing")).rejects.toThrow(
        /projectsRoot must be absolute/,
      );
      await expect(fixture.open("missing")).rejects.toThrow(
        XdgProjectRuntimeLocationError,
      );
      for (const key of ["", ".", "..", "../escape", "nested/key", "nested\\key", "/absolute"]) {
        await expect(fixture.open(key)).rejects.toThrow(
          XdgProjectRuntimeLocationError,
        );
      }

      await fixture.prepare("unreadable", []);
      await fixture.makeCorrupt("unreadable");
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
      const configPath = await fixture.installRedirectingConfig("redirect-target");
      expect(configPath).toBe(path.join(fixture.repositoryRoot, "cq.toml"));
      expect(path.relative(fixture.root, configPath).startsWith("..")).toBe(true);
      const selected = await fixture.openFromRepository("selected");
      const redirectTarget = await fixture.open("redirect-target");
      try {
        const created = await selected.store.createMilestone({ title: "selected only" });
        expect(created.id).toBe("M1");
        expect(() => redirectTarget.store.fetchItem("milestones", "M1")).toThrow();
        expect(await fixture.repositoryBackendArtifactExists()).toBe(false);
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
    const fixture = await realRuntimeFixture("t832-corrupt-");
    await fixture.prepare("corrupt", []);
    await fixture.makeCorrupt("corrupt");
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
    const fixture = await realRuntimeFixture("t832-escape-");
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
    const fixture = await realRuntimeFixture("t832-sidecars-");
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

async function realRuntimeFixture(prefix: string): Promise<RealRuntimeFixture> {
  return new RealRuntimeFixture(
    await freshProjectsRoot(`${prefix}projects-`),
    await freshProjectsRoot(`${prefix}repository-`),
  );
}

const getuid = process.getuid;
const permissionTest =
  process.platform !== "win32" &&
  typeof getuid === "function" &&
  getuid() !== 0
    ? test
    : test.skip;

describe("explicit XDG runtime access preflight", () => {
  permissionTest("rejects a state directory without write permission", async () => {
    const fixture = await realRuntimeFixture("t832-state-access-");
    await fixture.prepare("inaccessible-state", []);
    const stateDir = path.join(fixture.root, "inaccessible-state", "state");
    await chmod(stateDir, 0o500);
    try {
      await expect(fixture.open("inaccessible-state")).rejects.toThrow(
        /state directory is not readable and writable/,
      );
    } finally {
      await chmod(stateDir, 0o700);
    }
  });

  permissionTest("rejects a database that cannot be opened read-write", async () => {
    const fixture = await realRuntimeFixture("t832-db-access-");
    await fixture.prepare("inaccessible-db", []);
    const dbPath = path.join(
      fixture.root,
      "inaccessible-db",
      "state",
      "ledger.db",
    );
    await chmod(dbPath, 0o400);
    try {
      await expect(fixture.open("inaccessible-db")).rejects.toThrow(
        /ledger database is not writable/,
      );
    } finally {
      await chmod(dbPath, 0o600);
    }
  });

  permissionTest("rejects a logs directory without write permission", async () => {
    const fixture = await realRuntimeFixture("t832-logs-access-");
    await fixture.prepare("inaccessible-logs", []);
    await fixture.seedLog("inaccessible-logs", "session.md", "log");
    const logsDir = path.join(fixture.root, "inaccessible-logs", "logs");
    await chmod(logsDir, 0o500);
    try {
      await expect(fixture.open("inaccessible-logs")).rejects.toThrow(
        /logs directory is not readable and writable/,
      );
    } finally {
      await chmod(logsDir, 0o700);
    }
  });
});
