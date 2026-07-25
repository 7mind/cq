import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  PROJECT_DISPLAY_NAME_META_KEY,
  PROJECT_REPOSITORY_PATH_META_KEY,
  SqliteLedgerStore,
  TASKS_LEDGER,
  openXdgProjectRuntime,
  type XdgProjectRuntime,
} from "@cq/ledger";
import {
  createLedgerMcpServer,
  InMemoryPromptArtifactStore,
} from "../src/main.js";

const exec = promisify(execFile);
const cleanupPaths: string[] = [];
const PROJECT_KEY = "selected-project";
const PROMPT_TEMPLATE = "Packaged prompt independent of repository provenance.\n";
const RUNTIME_LOG_PATH = "runtime-write.md";
const RUNTIME_LOG_CONTENT = "runtime log write\n";
const encoder = new TextEncoder();

type RuntimeWithConfigRoot = XdgProjectRuntime & {
  readonly configRoot?: string;
};

interface RepositorySnapshot {
  readonly config: Uint8Array;
  readonly sentinel: Uint8Array;
  readonly status: string;
}

interface ToolResult {
  readonly isError?: boolean;
  readonly content?: Array<{ readonly type: string; readonly text?: string }>;
}

afterAll(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((candidate) =>
      rm(candidate, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

async function createRepository(
  marker: string,
  projectKey: string,
): Promise<string> {
  const repository = await temporaryDirectory(`t833-${marker}-`);
  await exec("git", ["init", "-q"], { cwd: repository });
  await exec("git", ["config", "user.email", "t833@example.test"], {
    cwd: repository,
  });
  await exec("git", ["config", "user.name", "T833"], { cwd: repository });
  await exec("git", ["config", "commit.gpgsign", "false"], {
    cwd: repository,
  });
  await writeFile(path.join(repository, "sentinel.txt"), `${marker}\n`);
  await mkdir(path.join(repository, "nested"));
  await writeFile(path.join(repository, "nested", "keep.txt"), "tracked\n");
  await writeFile(
    path.join(repository, "cq.toml"),
    [
      `reviewers = ["${marker}"]`,
      `planners = ["${marker}"]`,
      "",
      "[aliases]",
      `${marker} = "claude:opus-4.8[1m]"`,
      "",
      "[ledger]",
      'backend = "fs"',
      `projectId = "${projectKey}"`,
      "",
    ].join("\n"),
  );
  await exec("git", ["add", "cq.toml", "sentinel.txt", "nested/keep.txt"], {
    cwd: repository,
  });
  await exec("git", ["commit", "-q", "-m", `seed ${marker}`], {
    cwd: repository,
  });
  return realpath(repository);
}

async function createMatchingNonRepository(
  directory: string,
  gitMarker: "file" | "directory" | null,
): Promise<string> {
  await writeFile(
    path.join(directory, "cq.toml"),
    `[ledger]\nprojectId = "${PROJECT_KEY}"\n`,
  );
  if (gitMarker === "file") {
    await writeFile(path.join(directory, ".git"), "arbitrary marker text\n");
  }
  if (gitMarker === "directory") {
    await mkdir(path.join(directory, ".git"));
  }
  return directory;
}

async function createLinkedWorktree(repository: string): Promise<string> {
  const parent = await temporaryDirectory("t833-linked-parent-");
  const linkedWorktree = path.join(parent, "checkout");
  await exec(
    "git",
    ["worktree", "add", "--detach", "-q", linkedWorktree, "HEAD"],
    { cwd: repository },
  );
  return realpath(linkedWorktree);
}

async function prepareProject(
  projectsRoot: string,
  repositoryPath: string | null,
): Promise<void> {
  const projectRoot = path.join(projectsRoot, PROJECT_KEY);
  const stateDir = path.join(projectRoot, "state");
  const logsDir = path.join(projectRoot, "logs");
  const dbPath = path.join(stateDir, "ledger.db");
  await mkdir(stateDir, { recursive: true });
  const store = new SqliteLedgerStore({ dbPath, logsDir });
  await store.init();
  await store.dispose();
  await mkdir(logsDir, { recursive: true });
  await writeFile(path.join(logsDir, "session.md"), "selected project log\n");

  if (repositoryPath === null) return;
  const db = new Database(dbPath);
  try {
    const put = db.query(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    put.run(PROJECT_REPOSITORY_PATH_META_KEY, repositoryPath);
    put.run(PROJECT_DISPLAY_NAME_META_KEY, "Selected project");
  } finally {
    db.close();
  }
}

async function repositorySnapshot(
  repository: string,
): Promise<RepositorySnapshot> {
  const { stdout } = await exec(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repository },
  );
  return {
    config: await readFile(path.join(repository, "cq.toml")),
    sentinel: await readFile(path.join(repository, "sentinel.txt")),
    status: stdout,
  };
}

function promptArtifactStore(): InMemoryPromptArtifactStore {
  return new InMemoryPromptArtifactStore(
    encoder.encode(
      JSON.stringify([
        {
          roleId: "plan-advance",
          roleKind: "dispatched-subagent",
          sidecar: { schemaRoleId: "plan-advance" },
        },
      ]),
    ),
    [{ roleId: "plan-advance", bytes: encoder.encode(PROMPT_TEMPLATE) }],
  );
}

async function withRuntimeClient(
  runtime: RuntimeWithConfigRoot,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createLedgerMcpServer({
    store: runtime.store,
    displayName: "Selected project",
    projectKey: runtime.projectKey,
    promptArtifactStore: promptArtifactStore(),
    ...(runtime.configRoot === undefined
      ? {}
      : { configRoot: runtime.configRoot }),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "t833-runtime-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("");
}

async function assertSelectedProjectReadWrite(
  runtime: RuntimeWithConfigRoot,
): Promise<void> {
  const milestone = await runtime.store.createMilestone({
    title: "Writable selected project",
  });
  const item = await runtime.store.createItem(TASKS_LEDGER, milestone.id, {
    status: "planned",
    fields: { headline: "Selected project mutation" },
  });
  expect(item.id).toBe("T1");
  expect(runtime.store.fetchItem(TASKS_LEDGER, item.id).fields.headline).toBe(
    "Selected project mutation",
  );
  expect((await runtime.store.readLog("session.md")).content).toBe(
    "selected project log\n",
  );
  await writeFile(
    path.join(runtime.logsDir, RUNTIME_LOG_PATH),
    RUNTIME_LOG_CONTENT,
  );
  expect((await runtime.store.readLog(RUNTIME_LOG_PATH)).content).toBe(
    RUNTIME_LOG_CONTENT,
  );
}

async function assertPackagedPromptAvailable(client: Client): Promise<void> {
  const result = (await client.callTool({
    name: "fetch_prompt",
    arguments: { roleId: "plan-advance" },
  })) as ToolResult;
  expect(result.isError ?? false).toBe(false);
  const prompt = JSON.parse(textOf(result)) as { promptTemplate: string };
  expect(prompt.promptTemplate).toBe(PROMPT_TEMPLATE);
}

async function assertSelectedLogAvailable(client: Client): Promise<void> {
  const result = (await client.callTool({
    name: "read_log",
    arguments: { path: RUNTIME_LOG_PATH },
  })) as ToolResult;
  expect(result.isError ?? false).toBe(false);
  const log = JSON.parse(textOf(result)) as { content: string };
  expect(log.content).toBe(RUNTIME_LOG_CONTENT);
}

describe("explicit XDG runtime repository provenance capabilities", () => {
  test("canonical matching provenance wires repository config without mutating the checkout", async () => {
    const projectsRoot = await temporaryDirectory("t833-projects-valid-");
    const selectedRepository = await createRepository(
      "selected",
      PROJECT_KEY,
    );
    const unrelatedRepository = await createRepository(
      "unrelated",
      "unrelated-project",
    );
    await prepareProject(
      projectsRoot,
      path.join(selectedRepository, "nested", ".."),
    );
    const selectedBefore = await repositorySnapshot(selectedRepository);
    const unrelatedBefore = await repositorySnapshot(unrelatedRepository);
    const previousCwd = process.cwd();
    process.chdir(unrelatedRepository);
    let runtime: RuntimeWithConfigRoot | null = null;
    try {
      runtime = await openXdgProjectRuntime({
        projectsRoot,
        projectKey: PROJECT_KEY,
      });
      expect(runtime.configRoot).toBe(await realpath(selectedRepository));
      await assertSelectedProjectReadWrite(runtime);
      await withRuntimeClient(runtime, async (client) => {
        const result = (await client.callTool({
          name: "get_config",
          arguments: {},
        })) as ToolResult;
        expect(result.isError ?? false).toBe(false);
        const config = JSON.parse(textOf(result)) as {
          configured: boolean;
          reviewers: string[];
        };
        expect(config.configured).toBe(true);
        expect(config.reviewers).toEqual(["selected"]);
        await assertSelectedLogAvailable(client);
        await assertPackagedPromptAvailable(client);
      });
    } finally {
      process.chdir(previousCwd);
      await runtime?.dispose();
    }
    expect(await repositorySnapshot(selectedRepository)).toEqual(
      selectedBefore,
    );
    expect(await repositorySnapshot(unrelatedRepository)).toEqual(
      unrelatedBefore,
    );
  });

  test("canonical matching linked-worktree provenance remains available", async () => {
    const projectsRoot = await temporaryDirectory("t833-projects-linked-");
    const repository = await createRepository("linked", PROJECT_KEY);
    const linkedWorktree = await createLinkedWorktree(repository);
    await prepareProject(projectsRoot, linkedWorktree);
    const runtime = await openXdgProjectRuntime({
      projectsRoot,
      projectKey: PROJECT_KEY,
    });
    try {
      expect(runtime.configRoot).toBe(linkedWorktree);
      await withRuntimeClient(runtime, async (client) => {
        const result = (await client.callTool({
          name: "get_config",
          arguments: {},
        })) as ToolResult;
        expect(result.isError ?? false).toBe(false);
        const config = JSON.parse(textOf(result)) as {
          configured: boolean;
          reviewers: string[];
        };
        expect(config.configured).toBe(true);
        expect(config.reviewers).toEqual(["linked"]);
      });
    } finally {
      await runtime.dispose();
    }
  });

  const invalidCases: ReadonlyArray<{
    readonly name: string;
    repositoryPath(
      projectsRoot: string,
      unrelatedRepository: string,
    ): string | null | Promise<string | null>;
  }> = [
    {
      name: "missing",
      repositoryPath: () => null,
    },
    {
      name: "relative",
      repositoryPath: () => "relative/checkout",
    },
    {
      name: "stale",
      repositoryPath: (projectsRoot) =>
        path.join(projectsRoot, "removed-checkout"),
    },
    {
      name: "mismatched",
      repositoryPath: (_projectsRoot, unrelatedRepository) =>
        unrelatedRepository,
    },
    {
      name: "matching non-repository",
      repositoryPath: (projectsRoot) =>
        createMatchingNonRepository(projectsRoot, null),
    },
    {
      name: "matching arbitrary .git file",
      repositoryPath: (projectsRoot) =>
        createMatchingNonRepository(projectsRoot, "file"),
    },
    {
      name: "matching empty .git directory",
      repositoryPath: (projectsRoot) =>
        createMatchingNonRepository(projectsRoot, "directory"),
    },
  ];

  for (const invalidCase of invalidCases) {
    test(`${invalidCase.name} provenance leaves config unwired without losing selected-project writes`, async () => {
      const projectsRoot = await temporaryDirectory(
        `t833-projects-${invalidCase.name}-`,
      );
      const unrelatedRepository = await createRepository(
        `unrelated_${invalidCase.name}`,
        `unrelated-${invalidCase.name}`,
      );
      await prepareProject(
        projectsRoot,
        await invalidCase.repositoryPath(projectsRoot, unrelatedRepository),
      );
      const unrelatedBefore = await repositorySnapshot(unrelatedRepository);
      const previousCwd = process.cwd();
      process.chdir(unrelatedRepository);
      let runtime: RuntimeWithConfigRoot | null = null;
      try {
        runtime = await openXdgProjectRuntime({
          projectsRoot,
          projectKey: PROJECT_KEY,
        });
        expect(runtime.configRoot).toBeUndefined();
        await assertSelectedProjectReadWrite(runtime);
        await withRuntimeClient(runtime, async (client) => {
          const result = (await client.callTool({
            name: "get_config",
            arguments: {},
          })) as ToolResult;
          expect(result.isError).toBe(true);
          const text = textOf(result);
          expect(text).toContain("not implemented");
          expect(text).not.toContain(`unrelated_${invalidCase.name}`);
          await assertSelectedLogAvailable(client);
          await assertPackagedPromptAvailable(client);
        });
      } finally {
        process.chdir(previousCwd);
        await runtime?.dispose();
      }
      expect(await repositorySnapshot(unrelatedRepository)).toEqual(
        unrelatedBefore,
      );
    });
  }
});
