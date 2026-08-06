import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn as bunSpawn, type Subprocess } from "bun";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { serializePromptSurfaceManifest } from "@cq/config";
import {
  createAttestationStoreForConstruction,
  resolveSingleProjectAttestationNamespace,
} from "@cq/ledger";
import { assertDispatchConstructionConformance } from "./dispatchConstructionConformance.js";

const here = new URL(".", import.meta.url).pathname;
const mainPath = path.resolve(here, "..", "src", "main.ts");
const SURFACES = ["claude", "codex", "pi"] as const;
type PromptSurface = (typeof SURFACES)[number];
const DISPATCHED_ROLE_ID = "plan-advance";
const WORKER_ROLE_ID = "implement-worker";
const ORCHESTRATOR_ROLE_ID = "advance";
const PROMPT_BYTES: Readonly<Record<PromptSurface, string>> = {
  claude: "standalone claude Agent and $ARGUMENTS\n",
  codex: "standalone codex collaboration and $ARGUMENTS\n",
  pi: "standalone pi dispatch_agent and $ARGUMENTS\n",
};
const WORKER_PROMPT_BYTES: Readonly<Record<PromptSurface, string>> = {
  claude: "standalone claude implement-worker input retrieval\n",
  codex: "standalone codex implement-worker input retrieval\n",
  pi: "standalone pi implement-worker direct input\n",
};

const INTENTIONAL_DIFFERENCE = {
  kind: "tool-vocabulary",
  reason: "Each prompt surface exposes different host tool names.",
  surfaces: SURFACES,
} as const;

const FRAGMENT_BINDING = {
  fragment: "host-tool-vocabulary",
  sourceBlock: "frontmatter host tool and isolation capabilities",
  supportedSurfaces: SURFACES,
  forbiddenVocabulary: {
    claude: ["$cq-"],
    codex: ["Agent"],
    pi: ["Agent"],
  },
  intentionalDifference: INTENTIONAL_DIFFERENCE,
} as const;

const CATALOG = [
  {
    roleId: DISPATCHED_ROLE_ID,
    roleKind: "dispatched-subagent",
    canonicalSource: `agents/${DISPATCHED_ROLE_ID}.md`,
    surfaces: SURFACES,
    sharedSourceBlock: {
      classification: "shared-prose",
      sourceBlock: "all prose outside the classified surface-sensitive blocks",
      targetFragment: null,
    },
    fragmentBindings: [FRAGMENT_BINDING],
    dispatchRelations: [],
    intentionalDifferences: [INTENTIONAL_DIFFERENCE],
    sidecar: { schemaRoleId: DISPATCHED_ROLE_ID },
  },
  {
    roleId: WORKER_ROLE_ID,
    roleKind: "dispatched-subagent",
    canonicalSource: `agents/${WORKER_ROLE_ID}.md`,
    surfaces: SURFACES,
    sharedSourceBlock: {
      classification: "shared-prose",
      sourceBlock: "all prose outside the classified surface-sensitive blocks",
      targetFragment: null,
    },
    fragmentBindings: [],
    dispatchRelations: [],
    intentionalDifferences: [],
    sidecar: { schemaRoleId: WORKER_ROLE_ID },
  },
  {
    roleId: ORCHESTRATOR_ROLE_ID,
    roleKind: "orchestrator-command",
    canonicalSource: `commands/cq/${ORCHESTRATOR_ROLE_ID}.md`,
    surfaces: SURFACES,
    sharedSourceBlock: {
      classification: "shared-prose",
      sourceBlock: "all prose outside the classified surface-sensitive blocks",
      targetFragment: null,
    },
    fragmentBindings: [FRAGMENT_BINDING],
    dispatchRelations: [{ kind: "dispatch", targetRoleId: DISPATCHED_ROLE_ID }],
    intentionalDifferences: [INTENTIONAL_DIFFERENCE],
    sidecar: null,
  },
] as const;

interface PriorFetchPromptResult {
  readonly roleId: string;
  readonly kind: "dispatched-subagent" | "orchestrator-command";
  readonly dispatched: boolean;
  readonly promptTemplate: string;
  readonly version?: number;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

interface NewFetchPromptResult extends PriorFetchPromptResult {
  readonly promptSurface: PromptSurface;
  readonly renderer: {
    readonly sharedSourceBlock: Readonly<Record<string, unknown>>;
    readonly fragmentBindings: readonly Readonly<Record<string, unknown>>[];
  };
  readonly sourcePath: string;
  readonly workflowDependencies: readonly {
    readonly kind: "dispatch" | "recursion";
    readonly targetRoleId: string;
  }[];
  readonly requiredCapabilities: readonly string[];
  readonly intentionalDifferences: readonly Readonly<Record<string, unknown>>[];
}

let tmpRoot: string;
let xdgHome: string;
let surfacesRoot: string;
let surfaceRoots: Readonly<Record<PromptSurface, string>>;

function childEnv(
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      name !== "CQ_PROMPT_ROOT" &&
      name !== "CQ_PROMPT_SURFACE" &&
      name !== "CQ_PROMPT_SURFACES_ROOT"
    ) {
      environment[name] = value;
    }
  }
  return { ...environment, XDG_STATE_HOME: xdgHome, ...overrides };
}

function decodeResult(result: unknown): NewFetchPromptResult {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected prompt result text");
  }
  return JSON.parse(first.text) as NewFetchPromptResult;
}

function decodePriorFields(result: unknown): PriorFetchPromptResult {
  const decoded = decodeResult(result);
  const {
    roleId,
    kind,
    dispatched,
    promptTemplate,
    version,
    inputSchema,
    outputSchema,
  } = decoded;
  return {
    roleId,
    kind,
    dispatched,
    promptTemplate,
    ...(version !== undefined ? { version } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  };
}

function errorText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0]?.text ?? "";
}

async function fetchPrompt(client: Client, roleId: string): Promise<unknown> {
  return await client.callTool({
    name: "fetch_prompt",
    arguments: { roleId },
  });
}

function assertNewMetadata(result: NewFetchPromptResult, surface: PromptSurface): void {
  expect(result.promptSurface).toBe(surface);
  expect(result.renderer).toEqual({
    sharedSourceBlock: CATALOG[0].sharedSourceBlock,
    fragmentBindings: [FRAGMENT_BINDING],
  });
  expect(result.sourcePath).toBe(`agents/${DISPATCHED_ROLE_ID}.md`);
  expect(result.workflowDependencies).toEqual([]);
  expect(result.requiredCapabilities).toEqual(["host-tool-vocabulary"]);
  expect(result.intentionalDifferences).toEqual([INTENTIONAL_DIFFERENCE]);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected TCP address"));
        return;
      }
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`ledger-mcp did not bind port ${String(port)}`);
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-prompt-transport-"));
  xdgHome = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-prompt-xdg-"));
  await fs.writeFile(
    path.join(tmpRoot, "cq.toml"),
    `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(tmpRoot)}"\n`,
  );
  surfacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-mcp-prompt-surfaces-"));
  surfaceRoots = Object.fromEntries(
    SURFACES.map((surface) => [surface, path.join(surfacesRoot, surface)]),
  ) as Readonly<Record<PromptSurface, string>>;
  for (const surface of SURFACES) {
    const surfaceRoot = surfaceRoots[surface];
    await fs.mkdir(path.join(surfaceRoot, "roles"), { recursive: true });
    const catalogJson = JSON.stringify(CATALOG);
    await fs.writeFile(path.join(surfaceRoot, "catalog.json"), catalogJson);
    const dispatchedBytes = PROMPT_BYTES[surface];
    const orchestratorBytes = `orchestrator ${surface}\n`;
    const dispatchedSchema = JSON.stringify({
      id: DISPATCHED_ROLE_ID,
      version: 2,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    const workerSchema = JSON.stringify({
      id: WORKER_ROLE_ID,
      version: 1,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    const roles = [
      {
        roleId: DISPATCHED_ROLE_ID,
        version: 2,
        sha256: createHash("sha256").update(dispatchedBytes, "utf8").digest("hex"),
        schemaSha256: createHash("sha256").update(dispatchedSchema, "utf8").digest("hex"),
      },
      {
        roleId: ORCHESTRATOR_ROLE_ID,
        version: null,
        sha256: createHash("sha256").update(orchestratorBytes, "utf8").digest("hex"),
        schemaSha256: null,
      },
      {
        roleId: WORKER_ROLE_ID,
        version: 1,
        sha256: createHash("sha256")
          .update(WORKER_PROMPT_BYTES[surface], "utf8")
          .digest("hex"),
        schemaSha256: createHash("sha256").update(workerSchema, "utf8").digest("hex"),
      },
    ];
    await fs.writeFile(
      path.join(surfaceRoot, "surface.json"),
      serializePromptSurfaceManifest(
        surface,
        createHash("sha256").update(catalogJson, "utf8").digest("hex"),
        roles,
      ),
    );
    await fs.mkdir(path.join(surfaceRoot, "schemas"), { recursive: true });
    await fs.writeFile(
      path.join(surfaceRoot, "schemas", `${DISPATCHED_ROLE_ID}.json`),
      dispatchedSchema,
    );
    await fs.writeFile(
      path.join(surfaceRoot, "schemas", `${WORKER_ROLE_ID}.json`),
      workerSchema,
    );
    await fs.writeFile(
      path.join(surfaceRoot, "roles", `${DISPATCHED_ROLE_ID}.md`),
      dispatchedBytes,
    );
    await fs.writeFile(
      path.join(surfaceRoot, "roles", `${ORCHESTRATOR_ROLE_ID}.md`),
      orchestratorBytes,
    );
    await fs.writeFile(
      path.join(surfaceRoot, "roles", `${WORKER_ROLE_ID}.md`),
      WORKER_PROMPT_BYTES[surface],
    );
  }
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(xdgHome, { recursive: true, force: true });
  await fs.rm(surfacesRoot, { recursive: true, force: true });
});

describe("standalone prompt-surface transports", () => {
  test("stdio preserves the T977 dispatch contract through its production construction", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "run",
        mainPath,
        "--cwd",
        tmpRoot,
        "--prompt-surface",
        "codex",
        "--prompt-root",
        surfaceRoots.codex,
      ],
      env: childEnv({}),
      stderr: "pipe",
    });
    const client = new Client(
      { name: "dispatch-stdio-construction-test", version: "0.0.1" },
      { capabilities: {} },
    );
    const namespace = await resolveSingleProjectAttestationNamespace({
      construction: "stdio",
      backend: "xdg",
      repoRoot: tmpRoot,
      projectId: path.basename(tmpRoot),
    });
    const peer = await createAttestationStoreForConstruction({
      backend: "xdg",
      namespace,
      env: { XDG_STATE_HOME: xdgHome },
    });
    try {
      await client.connect(transport);
      await assertDispatchConstructionConformance({
        cell: "stdio",
        client,
        surface: "codex",
        rows: async () =>
          (await peer.transact({ kind: "namespace" }, (store) => store.rows())) ?? [],
      });
    } finally {
      await client.close();
      await peer.close();
    }
  });

  test("HTTP preserves the T977 dispatch contract through its production construction", async () => {
    const port = await freePort();
    const processHandle: Subprocess = bunSpawn({
      cmd: [
        process.execPath,
        "run",
        mainPath,
        "--cwd",
        tmpRoot,
        "--http",
        `127.0.0.1:${String(port)}`,
      ],
      env: childEnv({
        CQ_PROMPT_SURFACE: "claude",
        CQ_PROMPT_ROOT: surfaceRoots.claude,
      }),
      stdout: "ignore",
      stderr: "ignore",
    });
    const namespace = await resolveSingleProjectAttestationNamespace({
      construction: "http-single-project",
      backend: "xdg",
      repoRoot: tmpRoot,
      projectId: path.basename(tmpRoot),
    });
    const peer = await createAttestationStoreForConstruction({
      backend: "xdg",
      namespace,
      env: { XDG_STATE_HOME: xdgHome },
    });
    try {
      await waitForPort(port);
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(port)}/mcp`),
      );
      const client = new Client(
        { name: "dispatch-http-construction-test", version: "0.0.1" },
        { capabilities: {} },
      );
      await client.connect(transport as unknown as Transport);
      try {
        await assertDispatchConstructionConformance({
          cell: "http-single-project",
          client,
          surface: "claude",
          rows: async () =>
            (await peer.transact({ kind: "namespace" }, (store) => store.rows())) ?? [],
        });
      } finally {
        await client.close();
      }
    } finally {
      await peer.close();
      processHandle.kill();
      await processHandle.exited;
    }
  });

  test("stdio rejects a selected surface that does not match the built root", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "run",
        mainPath,
        "--cwd",
        tmpRoot,
        "--prompt-surface",
        "pi",
        "--prompt-root",
        surfaceRoots.codex,
      ],
      env: childEnv({}),
      stderr: "pipe",
    });
    const client = new Client({ name: "prompt-stdio-mismatch-test", version: "0.0.1" }, {
      capabilities: {},
    });
    try {
      await expect(client.connect(transport)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  test("stdio supports prior and new consumers across all selected surfaces", async () => {
    const schemaBytes: string[] = [];
    for (const surface of SURFACES) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "run",
          mainPath,
          "--cwd",
          tmpRoot,
          "--prompt-surface",
          surface,
          "--prompt-root",
          surfaceRoots[surface],
        ],
        env: childEnv({}),
        stderr: "pipe",
      });
      const client = new Client({ name: "prompt-stdio-test", version: "0.0.1" }, {
        capabilities: {},
      });
      await client.connect(transport);
      try {
        const result = await fetchPrompt(client, DISPATCHED_ROLE_ID);
        const prior = decodePriorFields(result);
        expect(prior.promptTemplate).toBe(PROMPT_BYTES[surface]);
        expect(prior.roleId).toBe(DISPATCHED_ROLE_ID);
        expect(prior.dispatched).toBe(true);
        expect(prior.inputSchema).toBeDefined();
        expect(prior.outputSchema).toBeDefined();

        const current = decodeResult(result);
        assertNewMetadata(current, surface);
        schemaBytes.push(
          JSON.stringify({
            version: current.version,
            inputSchema: current.inputSchema,
            outputSchema: current.outputSchema,
          }),
        );

        const orchestrator = decodeResult(await fetchPrompt(client, ORCHESTRATOR_ROLE_ID));
        expect(orchestrator.promptSurface).toBe(surface);
        expect(orchestrator.sourcePath).toBe(`commands/cq/${ORCHESTRATOR_ROLE_ID}.md`);
        expect(orchestrator.workflowDependencies).toEqual([
          { kind: "dispatch", targetRoleId: DISPATCHED_ROLE_ID },
        ]);
        expect(orchestrator.inputSchema).toBeUndefined();
        expect(orchestrator.outputSchema).toBeUndefined();

        const unknown = await fetchPrompt(client, "no-such-role");
        expect((unknown as { isError?: boolean }).isError).toBe(true);
        expect(errorText(unknown)).toContain(
          'unknown role "no-such-role": not in the prompt catalog roster',
        );
      } finally {
        await client.close();
      }
    }
    expect(new Set(Object.values(PROMPT_BYTES)).size).toBe(SURFACES.length);
    expect(new Set(schemaBytes).size).toBe(1);
  });

  test("HTTP supports prior and new consumers across all selected surfaces", async () => {
    const schemaBytes: string[] = [];
    for (const surface of SURFACES) {
      const port = await freePort();
      const processHandle: Subprocess = bunSpawn({
        cmd: [
          process.execPath,
          "run",
          mainPath,
          "--cwd",
          tmpRoot,
          "--http",
          `127.0.0.1:${String(port)}`,
        ],
        env: childEnv({
          CQ_PROMPT_SURFACE: surface,
          CQ_PROMPT_SURFACES_ROOT: surfacesRoot,
        }),
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await waitForPort(port);
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${String(port)}/mcp`),
        );
        const client = new Client({ name: "prompt-http-test", version: "0.0.1" }, {
          capabilities: {},
        });
        await client.connect(transport as unknown as Transport);
        try {
          const result = await fetchPrompt(client, DISPATCHED_ROLE_ID);
          const prior = decodePriorFields(result);
          expect(prior.promptTemplate).toBe(PROMPT_BYTES[surface]);
          expect(prior.inputSchema).toBeDefined();
          expect(prior.outputSchema).toBeDefined();

          const current = decodeResult(result);
          assertNewMetadata(current, surface);
          schemaBytes.push(
            JSON.stringify({
              version: current.version,
              inputSchema: current.inputSchema,
              outputSchema: current.outputSchema,
            }),
          );

          const orchestrator = decodeResult(await fetchPrompt(client, ORCHESTRATOR_ROLE_ID));
          expect(orchestrator.promptSurface).toBe(surface);
          expect(orchestrator.inputSchema).toBeUndefined();
          expect(orchestrator.outputSchema).toBeUndefined();

          const unknown = await fetchPrompt(client, "no-such-role");
          expect((unknown as { isError?: boolean }).isError).toBe(true);
          expect(errorText(unknown)).toContain(
            'unknown role "no-such-role": not in the prompt catalog roster',
          );
        } finally {
          await client.close();
        }
      } finally {
        processHandle.kill();
        await processHandle.exited;
      }
    }
    expect(new Set(schemaBytes).size).toBe(1);
  });

  test("HTTP rejects a selected surface that does not match the built root", async () => {
    const port = await freePort();
    const processHandle: Subprocess = bunSpawn({
      cmd: [
        process.execPath,
        "run",
        mainPath,
        "--cwd",
        tmpRoot,
        "--http",
        `127.0.0.1:${String(port)}`,
      ],
      env: childEnv({
        CQ_PROMPT_SURFACE: "pi",
        CQ_PROMPT_ROOT: surfaceRoots.codex,
      }),
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const startup = await Promise.race([
        processHandle.exited.then(() => "exited" as const),
        waitForPort(port).then(() => "bound" as const),
      ]);
      expect(startup).toBe("exited");
    } finally {
      processHandle.kill();
      await processHandle.exited;
    }
  });
});
