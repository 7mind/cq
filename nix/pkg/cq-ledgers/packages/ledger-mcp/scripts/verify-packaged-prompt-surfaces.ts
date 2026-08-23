#!/usr/bin/env bun

import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { PROMPT_CATALOG_PROJECTION } from "../../cq-config/src/promptCatalog.gen.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEDGERS_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const REPO_ROOT = path.resolve(LEDGERS_ROOT, "..", "..", "..");
const SURFACES = ["claude", "codex", "pi"] as const;
const NESTED_ROLE_PATHS = [
  "begin.md",
  "plan.md",
  "plan/advance.md",
  "research.md",
  "research/advance.md",
] as const;
const GENERATED_PATHS = [
  "packages/cq-config/src/promptCatalog.gen.ts",
  "packages/ledger-web/src/agentsCatalogue.gen.ts",
] as const;
const TEMPORARY_RENDERED_NAMES = [".publication.lock"] as const;
const UNRESOLVED_RENDERER_PATTERN = /\{\{cq:fragment:|CQ_HARNESS/;
const PROJECTION_PATTERN = /projection:\s*"(?:compact|full)"/;
const FIXED_ACK_PATTERN = /fixed acknowledgement|never a full entity/;
const STALE_RESPONSE_PATTERNS = [
  /mutation[^.\n]*returns? (?:the )?full (?:item|entity)/i,
  /reload[^.\n]*mutation result/i,
  /read[^.\n]*mutation result/i,
] as const;

type PromptSurface = (typeof SURFACES)[number];

interface FetchPromptResult {
  readonly roleId: string;
  readonly promptSurface: PromptSurface;
  readonly promptTemplate: string;
  readonly version: number;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

interface PromptRoots {
  readonly claude: string;
  readonly codex: string;
  readonly pi: string;
}

interface McpModules {
  readonly Client: new (
    clientInfo: { readonly name: string; readonly version: string },
    options: { readonly capabilities: Readonly<Record<string, unknown>> },
  ) => {
    connect(transport: unknown): Promise<void>;
    callTool(request: {
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
    close(): Promise<void>;
  };
  readonly StdioClientTransport: new (options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly stderr: "pipe";
  }) => unknown;
  readonly StreamableHTTPClientTransport: new (url: URL) => unknown;
}

function commandText(command: readonly string[]): string {
  return command.join(" ");
}

function run(command: readonly string[], cwd: string): string {
  const result = Bun.spawnSync([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(
      `${commandText(command)} failed with exit ${String(result.exitCode)}\n${stdout}${stderr}`,
    );
  }
  return stdout;
}

function assertCleanGeneratedPath(relativePath: string): void {
  const repositoryPath = path.relative(REPO_ROOT, path.join(LEDGERS_ROOT, relativePath));
  for (const mode of [[], ["--cached"]] as const) {
    const result = Bun.spawnSync(["git", "diff", "--quiet", ...mode, "--", repositoryPath], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `freshness precondition failed: generated path already differs: ${relativePath}`,
      );
    }
  }
}

function assertSameBytes(
  stage: string,
  relativePath: string,
  expected: Uint8Array,
  actual: Uint8Array,
): void {
  if (!Buffer.from(expected).equals(Buffer.from(actual))) {
    throw new Error(`${stage}: changed path: ${relativePath}`);
  }
}

async function verifyGeneratorFreshness(): Promise<void> {
  for (const relativePath of GENERATED_PATHS) {
    assertCleanGeneratedPath(relativePath);
  }
  const baseline = await Promise.all(
    GENERATED_PATHS.map((relativePath) => readFile(path.join(LEDGERS_ROOT, relativePath))),
  );

  run(["bun", "run", "gen-prompt-catalog"], LEDGERS_ROOT);
  run(["bun", "run", "gen-agents"], LEDGERS_ROOT);
  const first = await Promise.all(
    GENERATED_PATHS.map((relativePath) => readFile(path.join(LEDGERS_ROOT, relativePath))),
  );
  for (const [index, relativePath] of GENERATED_PATHS.entries()) {
    assertSameBytes(
      "committed generator freshness failed",
      relativePath,
      baseline[index]!,
      first[index]!,
    );
  }

  run(["bun", "run", "gen-prompt-catalog"], LEDGERS_ROOT);
  run(["bun", "run", "gen-agents"], LEDGERS_ROOT);
  const second = await Promise.all(
    GENERATED_PATHS.map((relativePath) => readFile(path.join(LEDGERS_ROOT, relativePath))),
  );
  for (const [index, relativePath] of GENERATED_PATHS.entries()) {
    assertSameBytes(
      "second generator run was not byte-identical",
      relativePath,
      first[index]!,
      second[index]!,
    );
  }
  console.log("freshness: 2 generators x 2 runs byte-identical to committed paths");
}

function buildOutput(attribute: string): string {
  const output = run(["nix", "build", attribute, "--no-link", "--print-out-paths"], REPO_ROOT);
  const storePaths = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/nix/store/"));
  if (storePaths.length !== 1) {
    throw new Error(
      `Nix root discovery for ${attribute} returned ${String(storePaths.length)} store paths`,
    );
  }
  return storePaths[0]!;
}

function discoverPackagedOutputs(): {
  readonly cqBin: string;
  readonly roots: PromptRoots;
} {
  const cqOutput = buildOutput(".#cq");
  const roots = {
    claude: buildOutput(".#claude-prompt-root"),
    codex: buildOutput(".#codex-prompt-root"),
    pi: buildOutput(".#pi-prompt-root"),
  };
  const cqBin = path.join(cqOutput, "bin", "cq");
  console.log(`packaged cq: ${cqOutput}`);
  for (const surface of SURFACES) {
    console.log(`packaged ${surface} root: ${roots[surface]}`);
  }
  return { cqBin, roots };
}

async function loadMcpModules(): Promise<McpModules> {
  const sdkRoot = path.join(
    LEDGERS_ROOT,
    "packages",
    "ledger-mcp",
    "node_modules",
    "@modelcontextprotocol",
    "sdk",
    "dist",
    "esm",
  );
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] =
    await Promise.all([
      import(pathToFileURL(path.join(sdkRoot, "client", "index.js")).href),
      import(pathToFileURL(path.join(sdkRoot, "client", "stdio.js")).href),
      import(pathToFileURL(path.join(sdkRoot, "client", "streamableHttp.js")).href),
    ]);
  return {
    Client,
    StdioClientTransport,
    StreamableHTTPClientTransport,
  } as McpModules;
}

function childEnv(xdgStateHome: string): Record<string, string> {
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
  return { ...environment, XDG_STATE_HOME: xdgStateHome };
}

function decode(result: unknown): FetchPromptResult {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("fetch_prompt did not return text");
  }
  return JSON.parse(first.text) as FetchPromptResult;
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
    await Bun.sleep(25);
  }
  throw new Error(`packaged cq did not bind port ${String(port)}`);
}

async function fetchPrompt(client: {
  callTool(request: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}): Promise<FetchPromptResult> {
  return decode(
    await client.callTool({
      name: "fetch_prompt",
      arguments: { roleId: "plan-advance" },
    }),
  );
}

async function fetchOverStdio(
  modules: McpModules,
  cqBin: string,
  roots: PromptRoots,
  surface: PromptSurface,
  cwd: string,
  xdgStateHome: string,
): Promise<FetchPromptResult> {
  const transport = new modules.StdioClientTransport({
    command: cqBin,
    args: ["mcp", "--cwd", cwd, "--prompt-surface", surface, "--prompt-root", roots[surface]],
    env: childEnv(xdgStateHome),
    stderr: "pipe",
  });
  const client = new modules.Client(
    { name: "verify-packaged-prompt-stdio", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    return await fetchPrompt(client);
  } finally {
    await client.close();
  }
}

async function fetchOverHttp(
  modules: McpModules,
  cqBin: string,
  roots: PromptRoots,
  surface: PromptSurface,
  cwd: string,
  xdgStateHome: string,
): Promise<FetchPromptResult> {
  const port = await freePort();
  const processHandle = Bun.spawn({
    cmd: [
      cqBin,
      "mcp",
      "--cwd",
      cwd,
      "--http",
      `127.0.0.1:${String(port)}`,
      "--prompt-surface",
      surface,
      "--prompt-root",
      roots[surface],
    ],
    env: childEnv(xdgStateHome),
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await waitForPort(port);
    const transport = new modules.StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(port)}/mcp`),
    );
    const client = new modules.Client(
      { name: "verify-packaged-prompt-http", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(transport);
    try {
      return await fetchPrompt(client);
    } finally {
      await client.close();
    }
  } finally {
    processHandle.kill();
    await processHandle.exited;
  }
}

async function verifyPackagedTransports(
  modules: McpModules,
  cqBin: string,
  roots: PromptRoots,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cq-prompt-verify-cwd-"));
  const xdgStateHome = await mkdtemp(path.join(os.tmpdir(), "cq-prompt-verify-state-"));
  try {
    await writeFile(
      path.join(cwd, "cq.toml"),
      '[ledger]\nbackend = "xdg"\nprojectId = "packaged-prompt-verification"\n',
    );
    const schemaBytes: string[] = [];
    const promptBodies: string[] = [];
    for (const surface of SURFACES) {
      const expectedPrompt = await readFile(
        path.join(roots[surface], "roles", "plan-advance.md"),
        "utf8",
      );
      const stdio = await fetchOverStdio(modules, cqBin, roots, surface, cwd, xdgStateHome);
      const http = await fetchOverHttp(modules, cqBin, roots, surface, cwd, xdgStateHome);

      assert.equal(stdio.roleId, "plan-advance");
      assert.equal(http.roleId, "plan-advance");
      assert.equal(stdio.promptSurface, surface);
      assert.equal(http.promptSurface, surface);
      assert.equal(stdio.promptTemplate, expectedPrompt);
      assert.equal(http.promptTemplate, expectedPrompt);
      assert.deepEqual(http.inputSchema, stdio.inputSchema);
      assert.deepEqual(http.outputSchema, stdio.outputSchema);

      promptBodies.push(expectedPrompt);
      schemaBytes.push(
        JSON.stringify({
          version: stdio.version,
          inputSchema: stdio.inputSchema,
          outputSchema: stdio.outputSchema,
        }),
      );
      console.log(
        `${surface}: stdio+http bytes=${String(expectedPrompt.length)} schemas=identical`,
      );
    }
    assert.equal(
      new Set(promptBodies).size,
      SURFACES.length,
      "surface prompt bodies must be pairwise distinct",
    );
    assert.equal(
      new Set(schemaBytes).size,
      1,
      "all surfaces and transports must expose byte-equivalent schemas",
    );
    console.log("packaged prompt smoke: 6/6 transports passed; 3 surface bytes distinct");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(xdgStateHome, { recursive: true, force: true });
  }
}

async function walkFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files.sort();
}

export function assertPackagedRoleClosure(
  surface: PromptSurface,
  roleRoot: string,
  roleFiles: readonly string[],
): void {
  const expectedRoleFiles = PROMPT_CATALOG_PROJECTION.catalog
    .map(({ roleId }) => path.join(roleRoot, `${roleId}.md`))
    .sort();
  const actualRoleFiles = [...roleFiles].sort();
  const expectedRoleSet = new Set(expectedRoleFiles);
  const actualRoleSet = new Set(actualRoleFiles);
  const missing = expectedRoleFiles.filter((filePath) => !actualRoleSet.has(filePath));
  const unexpected = actualRoleFiles.filter((filePath) => !expectedRoleSet.has(filePath));
  const exact =
    actualRoleFiles.length === expectedRoleFiles.length &&
    actualRoleFiles.every((filePath, index) => filePath === expectedRoleFiles[index]);
  if (!exact) {
    const display = (filePaths: readonly string[]): string =>
      filePaths.length === 0
        ? "none"
        : filePaths.map((filePath) => path.relative(roleRoot, filePath)).join(", ");
    throw new Error(
      `${surface} role closure failed: ${roleRoot}: missing ${display(missing)}; unexpected ${display(unexpected)}`,
    );
  }
}

function assertNoStaleResponseProse(filePath: string, content: string): void {
  for (const pattern of STALE_RESPONSE_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(`stale response-contract prose: ${filePath}`);
    }
  }
}

async function verifyPackagedRoot(surface: PromptSurface, root: string): Promise<void> {
  const roleRoot = path.join(root, "roles");
  const roleFiles = (await walkFiles(roleRoot)).filter((filePath) => filePath.endsWith(".md"));
  assertPackagedRoleClosure(surface, roleRoot, roleFiles);

  const allFiles = await walkFiles(root);
  for (const filePath of allFiles) {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`raw-source/symlink hygiene failed: ${filePath}`);
    }
    const basename = path.basename(filePath);
    if (
      basename.startsWith(".tmp-") ||
      TEMPORARY_RENDERED_NAMES.includes(basename as (typeof TEMPORARY_RENDERED_NAMES)[number])
    ) {
      throw new Error(`temporary rendered-root artifact: ${filePath}`);
    }
    const content = await readFile(filePath, "utf8");
    if (UNRESOLVED_RENDERER_PATTERN.test(content)) {
      throw new Error(`unresolved renderer token: ${filePath}`);
    }
    assertNoStaleResponseProse(filePath, content);
  }

  for (const relativePath of NESTED_ROLE_PATHS) {
    const filePath = path.join(roleRoot, relativePath);
    const content = await readFile(filePath, "utf8");
    if (!PROJECTION_PATTERN.test(content)) {
      throw new Error(`missing explicit compact/full projection: ${filePath}`);
    }
    if (!FIXED_ACK_PATTERN.test(content)) {
      throw new Error(`missing fixed mutation acknowledgement: ${filePath}`);
    }
  }
  console.log(
    `${surface}: ${String(roleFiles.length)} roles; nested projection/ack and packaged hygiene passed`,
  );
}

async function verifyCanonicalResponseProse(): Promise<void> {
  for (const relativeRoot of ["nix/pkg/cq-assets/commands/cq", "nix/pkg/cq-assets/agents"]) {
    const root = path.join(REPO_ROOT, relativeRoot);
    for (const filePath of await walkFiles(root)) {
      if (filePath.endsWith(".md")) {
        assertNoStaleResponseProse(
          path.relative(REPO_ROOT, filePath),
          await readFile(filePath, "utf8"),
        );
      }
    }
  }
  console.log("canonical response prose: no legacy full-mutation assumptions");
}

async function main(): Promise<void> {
  console.log("dependency setup: bun install --frozen-lockfile");
  run(["bun", "install", "--frozen-lockfile"], LEDGERS_ROOT);
  const modules = await loadMcpModules();
  await verifyGeneratorFreshness();
  run(["bun", "test", "scripts/link-prompts.test.ts"], LEDGERS_ROOT);
  console.log(
    "link-prompts hygiene: dummy+filesystem contracts passed (current-root links and temporary-root cleanup)",
  );
  const { cqBin, roots } = discoverPackagedOutputs();
  await verifyPackagedTransports(modules, cqBin, roots);
  for (const surface of SURFACES) {
    await verifyPackagedRoot(surface, roots[surface]);
  }
  await verifyCanonicalResponseProse();
  console.log("verify-packaged-prompt-surfaces: PASS");
}

if (import.meta.main) {
  await main();
}
