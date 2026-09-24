/**
 * D403 / H310 — the single-project dispatch runtime executes the PROJECT's gate.
 *
 * The supervised gate runner used to be a module singleton built with CQ's own
 * `bun run check` in `nix/pkg/cq-ledgers`, so a consumer project's declared
 * `[gate]` was parsed and then dropped. This pins the join: the runtime
 * resolves the gate from the store's `configRoot` and carries it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { serializePromptSurfaceManifest } from "@cq/config";
import { CANONICAL_PROJECT_GATE, PROJECT_GATE_ROOT_CWD } from "@cq/config";
import { createLedgerStore } from "@cq/ledger";
import { createSingleProjectDispatchRuntime } from "../src/dispatchCapability.js";
import { FileSystemPromptArtifactStore } from "../src/promptArtifactStore.js";

const exec = promisify(execFile);
const dirs: string[] = [];
let originalXdgStateHome: string | undefined;
let xdgSaved = false;

afterAll(async () => {
  if (xdgSaved) {
    if (originalXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = originalXdgStateHome;
  }
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

async function project(prefix: string, gateSection: string): Promise<string> {
  if (!xdgSaved) {
    originalXdgStateHome = process.env["XDG_STATE_HOME"];
    xdgSaved = true;
    const home = await fs.mkdtemp(path.join(tmpdir(), "cq-gate-runtime-home-"));
    dirs.push(home);
    process.env["XDG_STATE_HOME"] = home;
  }
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  await exec("git", ["init", "-q"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), `# repo ${prefix}\n`);
  await fs.writeFile(path.join(dir, "cq.toml"), `[ledger]\n  backend = "xdg"\n${gateSection}`, "utf8");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function runtimeGateFor(prefix: string, gateSection: string) {
  const root = await project(prefix, gateSection);
  const resolved = await createLedgerStore(root);
  try {
    // Construction only requires an attested prompt surface to be PRESENT;
    // this suite never dispatches, so a role-less surface is enough.
    const promptRoot = await fs.mkdtemp(path.join(tmpdir(), "cq-gate-runtime-prompts-"));
    dirs.push(promptRoot);
    await fs.mkdir(path.join(promptRoot, "roles"), { recursive: true });
    await fs.mkdir(path.join(promptRoot, "schemas"), { recursive: true });
    const catalogBytes = JSON.stringify([]);
    await fs.writeFile(path.join(promptRoot, "catalog.json"), catalogBytes);
    await fs.writeFile(
      path.join(promptRoot, "surface.json"),
      serializePromptSurfaceManifest(
        "codex",
        createHash("sha256").update(catalogBytes).digest("hex"),
        [],
      ),
    );
    const runtime = await createSingleProjectDispatchRuntime({
      construction: "stdio",
      resolved,
      promptArtifactStore: new FileSystemPromptArtifactStore("codex", promptRoot),
      environment: process.env,
    });
    try {
      if (runtime.kind !== "available") throw new Error(`runtime unavailable: ${runtime.kind}`);
      return runtime.projectGate;
    } finally {
      await runtime.close();
    }
  } finally {
    await resolved.store.dispose();
  }
}

describe("D403 single-project dispatch runtime gate", () => {
  test("carries a consumer's declared gate, not CQ's layout", async () => {
    const gate = await runtimeGateFor(
      "cq-gate-runtime-declared-",
      '\n[gate]\n  argv = ["npm", "test"]\n  cwd = ""\n',
    );
    expect(gate.argv).toEqual(["npm", "test"]);
    expect(gate.cwd).toBe(PROJECT_GATE_ROOT_CWD);
    expect(gate.cwd).not.toBe(CANONICAL_PROJECT_GATE.cwd);
  }, 60_000);

  test("falls back to CQ's gate when the project declares none", async () => {
    expect(await runtimeGateFor("cq-gate-runtime-undeclared-", "")).toEqual(CANONICAL_PROJECT_GATE);
  }, 60_000);
});
