import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  computeManagedGateScriptDagSha256,
  resolveManagedGateClosure,
  type ManagedGateClosureManifestV1,
  type ManagedGateOpaqueEdgeDeclaration,
} from "../src/index.js";

const roots: string[] = [];
const TARGET_PACKAGE = "nix/pkg/cq-ledgers/package.json";
const TARGET_ROOT = path.dirname(TARGET_PACKAGE);

interface ClosureFixture {
  readonly root: string;
  readonly targetRoot: string;
  readonly scripts: Readonly<Record<string, string>>;
}

async function createFixture(
  scripts: Readonly<Record<string, string>> = {
    check: "tsc -b && bun run lint && bun test",
    lint: "eslint .",
  },
): Promise<ClosureFixture> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "t2290-gate-closure-"));
  roots.push(root);
  const targetRoot = path.join(root, TARGET_ROOT);
  await fs.mkdir(path.join(targetRoot, "test"), { recursive: true });
  await fs.writeFile(
    path.join(targetRoot, "package.json"),
    `${JSON.stringify({ name: "target", private: true, scripts }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(targetRoot, "bun.lock"), "{}\n");
  await fs.writeFile(path.join(targetRoot, "test", "gate.test.ts"), "export const gate = true;\n");
  return { root, targetRoot, scripts };
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeManifest(
  fixture: ClosureFixture,
  opaqueEdges: readonly ManagedGateOpaqueEdgeDeclaration[] = [],
): Promise<void> {
  const manifest: ManagedGateClosureManifestV1 = {
    version: 1,
    target: {
      packageJson: TARGET_PACKAGE,
      script: "check",
      scriptDagSha256: computeManagedGateScriptDagSha256(fixture.scripts, "check"),
    },
    opaqueEdges,
  };
  await fs.writeFile(
    path.join(fixture.root, "cq-gate-closure.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function addBunRoot(
  fixture: ClosureFixture,
  relativeRoot: string,
  source = "index.ts",
): Promise<string> {
  const root = path.join(fixture.root, relativeRoot);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"edge","private":true}\n');
  await fs.writeFile(path.join(root, "bun.lock"), "{}\n");
  await fs.writeFile(path.join(root, source), "export const edge = true;\n");
  return path.join(relativeRoot, source).split(path.sep).join("/");
}

async function createStandaloneBunRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "t2290-external-bun-root-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), '{"name":"external","private":true}\n');
  await fs.writeFile(path.join(root, "bun.lock"), "{}\n");
  await fs.writeFile(path.join(root, "index.ts"), "export const edge = true;\n");
  return root;
}

async function createExternalFile(name: string, bytes: string | Uint8Array): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "t2317-external-input-"));
  roots.push(root);
  const file = path.join(root, name);
  await fs.writeFile(file, bytes);
  return file;
}

async function replaceBunLockWithExternal(root: string): Promise<void> {
  const lockPath = path.join(root, "bun.lock");
  const externalLock = await createExternalFile("bun.lock", "{}\n");
  await fs.rm(lockPath);
  await fs.symlink(externalLock, lockPath, "file");
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("managed gate closure v1", () => {
  test("rejects a gate closure manifest symlink outside the repository", async () => {
    const fixture = await createFixture();
    await writeManifest(fixture);
    const manifestPath = path.join(fixture.root, "cq-gate-closure.json");
    const externalManifest = await createExternalFile(
      "cq-gate-closure.json",
      await fs.readFile(manifestPath),
    );
    await fs.rm(manifestPath);
    await fs.symlink(externalManifest, manifestPath, "file");

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects a target Bun lock symlink outside the repository", async () => {
    const fixture = await createFixture();
    await writeManifest(fixture);
    await replaceBunLockWithExternal(fixture.targetRoot);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects a static-import root Bun lock symlink outside the repository", async () => {
    const fixture = await createFixture();
    const source = await addBunRoot(fixture, "nix/pkg/static-root");
    await replaceBunLockWithExternal(path.dirname(path.join(fixture.root, source)));
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "gate.test.ts"),
      'import { edge } from "../../static-root/index.js";\nvoid edge;\n',
    );
    await writeManifest(fixture);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects a declared target root Bun lock symlink outside the repository", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.targetRoot, "test", "gate.test.ts");
    const sourceBytes =
      'const modulePath = "../../../declared-root/index.ts";\nawait import(modulePath);\n';
    await fs.writeFile(sourcePath, sourceBytes);
    const target = await addBunRoot(fixture, "nix/pkg/declared-root");
    await replaceBunLockWithExternal(path.dirname(path.join(fixture.root, target)));
    await writeManifest(fixture, [
      {
        kind: "dynamic",
        source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
        sha256: digest(sourceBytes),
        targets: [target],
      },
    ]);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects a manifest-declared source symlink outside the repository", async () => {
    const fixture = await createFixture();
    const sourceBytes =
      "const assetPath = process.env.ASSET_PATH!;\nawait Bun.file(assetPath).text();\n";
    const sourcePath = path.join(fixture.targetRoot, "test", "external-source.ts");
    const externalSource = await createExternalFile("external-source.ts", sourceBytes);
    await fs.symlink(externalSource, sourcePath, "file");
    await writeManifest(fixture, [
      {
        kind: "path",
        source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
        sha256: digest(sourceBytes),
        targets: [],
      },
    ]);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("rejects an executable source symlink outside the repository", async () => {
    const fixture = await createFixture();
    const markerPath = path.join(fixture.root, "source-symlink-marker.txt");
    await fs.writeFile(markerPath, "executed\n");
    const sourceBytes = [
      'import { expect, test } from "bun:test";',
      "const markerPath = process.env.T2317_SOURCE_SYMLINK_MARKER;",
      'if (markerPath === undefined) throw new Error("missing source symlink marker");',
      "const marker = await Bun.file(markerPath).text();",
      'test("external source symlink executes", () => {',
      '  console.log("T2317_EXTERNAL_SOURCE_SYMLINK_EXECUTED");',
      '  expect(marker).toBe("executed\\n");',
      "});",
      "",
    ].join("\n");
    const externalSource = await createExternalFile("escaped.test.ts", sourceBytes);
    const sourcePath = path.join(fixture.targetRoot, "test", "escaped.test.ts");
    await fs.symlink(externalSource, sourcePath, "file");
    await writeManifest(fixture);

    const executed = Bun.spawnSync([process.execPath, "test", sourcePath], {
      env: { ...process.env, T2317_SOURCE_SYMLINK_MARKER: markerPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const executionOutput = `${new TextDecoder().decode(executed.stdout)}${new TextDecoder().decode(executed.stderr)}`;
    expect(executed.exitCode).toBe(0);
    expect(executionOutput).toContain("T2317_EXTERNAL_SOURCE_SYMLINK_EXECUTED");

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("path-escape");
  });

  test("validates a source symlink target that remains inside the repository", async () => {
    const fixture = await createFixture();
    const sourceBytes =
      "const assetPath = process.env.ASSET_PATH!;\nawait Bun.file(assetPath).text();\n";
    const inputsRoot = path.join(fixture.root, "gate-inputs");
    await fs.mkdir(inputsRoot);
    const internalSource = path.join(inputsRoot, "internal-source.test.ts");
    await fs.writeFile(internalSource, sourceBytes);
    const sourcePath = path.join(fixture.targetRoot, "test", "internal-source.test.ts");
    await fs.symlink(path.relative(path.dirname(sourcePath), internalSource), sourcePath, "file");
    await writeManifest(fixture);

    const undeclared = await resolveManagedGateClosure(fixture.root);
    expect(undeclared.status).toBe("invalid");
    if (undeclared.status === "invalid") {
      expect(undeclared.reason).toBe("source-declaration-missing");
      expect(undeclared.detail).toContain("gate-inputs/internal-source.test.ts");
    }

    await writeManifest(fixture, [
      {
        kind: "path",
        source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
        sha256: digest(sourceBytes),
        targets: [],
      },
    ]);
    expect((await resolveManagedGateClosure(fixture.root)).status).toBe("resolved");
  });

  test("terminates discovery through an internal source symlink directory cycle", async () => {
    const fixture = await createFixture();
    await fs.symlink(
      fixture.targetRoot,
      path.join(fixture.targetRoot, "test", "target-loop"),
      "dir",
    );
    await writeManifest(fixture);

    expect((await resolveManagedGateClosure(fixture.root)).status).toBe("resolved");
  });

  test("accepts manifest and Bun lock symlinks that remain inside the repository", async () => {
    const fixture = await createFixture();
    await writeManifest(fixture);
    const inputsRoot = path.join(fixture.root, "gate-inputs");
    await fs.mkdir(inputsRoot);

    const manifestPath = path.join(fixture.root, "cq-gate-closure.json");
    const internalManifest = path.join(inputsRoot, "cq-gate-closure.json");
    await fs.rename(manifestPath, internalManifest);
    await fs.symlink(internalManifest, manifestPath, "file");

    const lockPath = path.join(fixture.targetRoot, "bun.lock");
    const internalLock = path.join(inputsRoot, "bun.lock");
    await fs.rename(lockPath, internalLock);
    await fs.symlink(internalLock, lockPath, "file");

    expect((await resolveManagedGateClosure(fixture.root)).status).toBe("resolved");
  });

  test("rejects target script DAG divergence and missing script edges", async () => {
    const fixture = await createFixture();
    await writeManifest(fixture);
    await fs.writeFile(
      path.join(fixture.targetRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "target",
          private: true,
          scripts: { ...fixture.scripts, check: "tsc -b && bun run lint && bun test --bail" },
        },
        null,
        2,
      )}\n`,
    );
    const diverged = await resolveManagedGateClosure(fixture.root);
    expect(diverged.status).toBe("invalid");
    if (diverged.status === "invalid") expect(diverged.reason).toBe("target-diverged");

    const missingFixture = await createFixture({ check: "bun run absent" });
    const missingManifest: ManagedGateClosureManifestV1 = {
      version: 1,
      target: {
        packageJson: TARGET_PACKAGE,
        script: "check",
        scriptDagSha256: "0".repeat(64),
      },
      opaqueEdges: [],
    };
    await fs.writeFile(
      path.join(missingFixture.root, "cq-gate-closure.json"),
      `${JSON.stringify(missingManifest, null, 2)}\n`,
    );
    const missing = await resolveManagedGateClosure(missingFixture.root);
    expect(missing.status).toBe("invalid");
    if (missing.status === "invalid") expect(missing.reason).toBe("script-edge-missing");
  });

  test("selects static-import roots and excludes unreachable Bun roots", async () => {
    const fixture = await createFixture();
    const reachableSource = await addBunRoot(fixture, "nix/pkg/reachable");
    await addBunRoot(fixture, "nix/pkg/unreachable");
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "gate.test.ts"),
      `import { edge } from "../../reachable/index.js";\nvoid edge;\n`,
    );
    await writeManifest(fixture);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.installRoots).toEqual([
      fixture.targetRoot,
      path.dirname(path.join(fixture.root, reachableSource)),
    ]);
    expect(resolution.installRoots).not.toContain(path.join(fixture.root, "nix/pkg/unreachable"));
  });

  test("rejects resolved static and declared targets outside the repository", async () => {
    const staticFixture = await createFixture();
    const staticExternalRoot = await createStandaloneBunRoot();
    const sourcePath = path.join(staticFixture.targetRoot, "test", "gate.test.ts");
    const externalSpecifier = path
      .relative(path.dirname(sourcePath), path.join(staticExternalRoot, "index.ts"))
      .split(path.sep)
      .join("/");
    await fs.writeFile(sourcePath, `import { edge } from ${JSON.stringify(externalSpecifier)};\n`);
    await writeManifest(staticFixture);

    const staticResolution = await resolveManagedGateClosure(staticFixture.root);
    expect(staticResolution.status).toBe("invalid");
    if (staticResolution.status === "invalid") {
      expect(staticResolution.reason).toBe("path-escape");
    }

    const missingFixture = await createFixture();
    await fs.writeFile(
      path.join(missingFixture.targetRoot, "test", "gate.test.ts"),
      ["im", 'port "../../../../../../outside-repository.ts";\n'].join(""),
    );
    await writeManifest(missingFixture);
    const missingResolution = await resolveManagedGateClosure(missingFixture.root);
    expect(missingResolution.status).toBe("invalid");
    if (missingResolution.status === "invalid") {
      expect(missingResolution.reason).toBe("path-escape");
    }

    const declaredFixture = await createFixture();
    const declaredExternalRoot = await createStandaloneBunRoot();
    const linkRoot = path.join(declaredFixture.root, "nix/pkg/external-link");
    await fs.mkdir(path.dirname(linkRoot), { recursive: true });
    await fs.symlink(declaredExternalRoot, linkRoot, "dir");
    const declaredSourcePath = path.join(declaredFixture.targetRoot, "test", "gate.test.ts");
    const declaredSourceBytes =
      'const modulePath = "../../../external-link/index.ts";\nawait import(modulePath);\n';
    await fs.writeFile(declaredSourcePath, declaredSourceBytes);
    await writeManifest(declaredFixture, [
      {
        kind: "dynamic",
        source: path.relative(declaredFixture.root, declaredSourcePath).split(path.sep).join("/"),
        sha256: digest(declaredSourceBytes),
        targets: ["nix/pkg/external-link/index.ts"],
      },
    ]);

    const declaredResolution = await resolveManagedGateClosure(declaredFixture.root);
    expect(declaredResolution.status).toBe("invalid");
    if (declaredResolution.status === "invalid") {
      expect(declaredResolution.reason).toBe("path-escape");
    }
  });

  test("canonicalizes target roots and rejects target symlinks outside the repository", async () => {
    const externalFixture = await createFixture();
    await writeManifest(externalFixture);
    const externalTargetRoot = await createStandaloneBunRoot();
    await fs.writeFile(
      path.join(externalTargetRoot, "package.json"),
      `${JSON.stringify(
        { name: "external", private: true, scripts: externalFixture.scripts },
        null,
        2,
      )}\n`,
    );
    await fs.rm(externalFixture.targetRoot, { recursive: true });
    await fs.symlink(externalTargetRoot, externalFixture.targetRoot, "dir");

    const externalResolution = await resolveManagedGateClosure(externalFixture.root);
    expect(externalResolution.status).toBe("invalid");
    if (externalResolution.status === "invalid") {
      expect(externalResolution.reason).toBe("path-escape");
    }

    const internalFixture = await createFixture();
    await writeManifest(internalFixture);
    const internalTargetRoot = path.join(internalFixture.root, "nix/pkg/cq-ledgers-real");
    await fs.rename(internalFixture.targetRoot, internalTargetRoot);
    await fs.symlink(internalTargetRoot, internalFixture.targetRoot, "dir");

    const internalResolution = await resolveManagedGateClosure(internalFixture.root);
    expect(internalResolution.status).toBe("resolved");
    if (internalResolution.status !== "resolved") return;
    expect(internalResolution.targetPackageJson).toBe(
      path.join(internalTargetRoot, "package.json"),
    );
    expect(internalResolution.installRoots).toEqual([internalTargetRoot]);
  });

  test("fails closed for an undeclared dynamic edge", async () => {
    const fixture = await createFixture();
    await fs.writeFile(
      path.join(fixture.targetRoot, "test", "gate.test.ts"),
      'const modulePath = "./fixture.ts";\nawait import(modulePath);\n',
    );
    await fs.writeFile(path.join(fixture.targetRoot, "test", "fixture.ts"), "export {};\n");
    await writeManifest(fixture);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") {
      expect(resolution.reason).toBe("source-declaration-missing");
      expect(resolution.detail).toContain("test/gate.test.ts");
    }
  });

  test("requires matching declarations for opaque path and spawn edges", async () => {
    for (const edge of [
      {
        expectedKind: "path" as const,
        wrongKind: "spawn" as const,
        source: "const assetPath = process.env.ASSET_PATH!;\nawait Bun.file(assetPath).text();\n",
      },
      {
        expectedKind: "spawn" as const,
        wrongKind: "path" as const,
        source:
          'import { spawn } from "node:child_process";\nconst scriptPath = process.env.SCRIPT_PATH!;\nspawn(process.execPath, [scriptPath]);\n',
      },
    ]) {
      const fixture = await createFixture();
      const sourcePath = path.join(fixture.targetRoot, "test", "gate.test.ts");
      await fs.writeFile(sourcePath, edge.source);
      const target = await addBunRoot(fixture, `nix/pkg/${edge.expectedKind}-target`);
      await writeManifest(fixture, [
        {
          kind: edge.wrongKind,
          source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
          sha256: digest(edge.source),
          targets: [target],
        },
      ]);

      const resolution = await resolveManagedGateClosure(fixture.root);
      expect(resolution.status).toBe("invalid");
      if (resolution.status === "invalid") {
        expect(resolution.reason).toBe("source-declaration-missing");
        expect(resolution.detail).toContain(`hashed ${edge.expectedKind} edge declaration`);
      }
    }
  });

  test("requires declarations for CommonJS path and spawn aliases", async () => {
    for (const edge of [
      {
        expectedKind: "path",
        sourceName: "opaque-path.cjs",
        source: [
          'const { readFile: loadAsset } = require("node:fs/promises");',
          "const assetPath = process.env.ASSET_PATH;",
          "await loadAsset(assetPath);",
          "",
        ].join("\n"),
      },
      {
        expectedKind: "spawn",
        sourceName: "opaque-spawn.cts",
        source: [
          'const processes = require("node:child_process");',
          "const scriptPath = process.env.SCRIPT_PATH;",
          "processes.spawn(process.execPath, [scriptPath]);",
          "",
        ].join("\n"),
      },
      {
        expectedKind: "spawn",
        sourceName: "opaque-destructured-spawn.cjs",
        source: [
          'const processes = require("node:child_process");',
          "const { spawn: run } = processes;",
          "const scriptPath = process.env.SCRIPT_PATH;",
          "run(process.execPath, [scriptPath]);",
          "",
        ].join("\n"),
      },
      {
        expectedKind: "spawn",
        sourceName: "opaque-one-line-destructured-spawn.cjs",
        source:
          'const processes = require("node:child_process"); const { spawn: run } = processes; const scriptPath = process.env.SCRIPT_PATH; run(process.execPath, [scriptPath]);\n',
      },
    ] as const) {
      const fixture = await createFixture();
      await fs.writeFile(path.join(fixture.targetRoot, "test", edge.sourceName), edge.source);
      await writeManifest(fixture);

      const resolution = await resolveManagedGateClosure(fixture.root);
      expect(resolution.status).toBe("invalid");
      if (resolution.status === "invalid") {
        expect(resolution.reason).toBe("source-declaration-missing");
        expect(resolution.detail).toContain(`hashed ${edge.expectedKind} edge declaration`);
      }
    }
  });

  test("rejects targetless declarations for variable dynamic imports", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.targetRoot, "test", "gate.test.ts");
    const sourceBytes = 'const modulePath = "./fixture.ts";\nawait import(modulePath);\n';
    await fs.writeFile(sourcePath, sourceBytes);
    await fs.writeFile(path.join(fixture.targetRoot, "test", "fixture.ts"), "export {};\n");
    await writeManifest(fixture, [
      {
        kind: "dynamic",
        source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
        sha256: digest(sourceBytes),
        targets: [],
      },
    ]);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("invalid");
    if (resolution.status === "invalid") expect(resolution.reason).toBe("edge-target-missing");
  });

  test("admits opaque path and spawn edges with matching hashed targets", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.targetRoot, "test", "gate.test.ts");
    const sourceBytes = [
      "const assetPath = process.env.ASSET_PATH!;",
      "await Bun.file(assetPath).text();",
      "const scriptPath = process.env.SCRIPT_PATH!;",
      "await Bun.spawn([process.execPath, scriptPath]).exited;",
      "",
    ].join("\n");
    await fs.writeFile(sourcePath, sourceBytes);
    const target = await addBunRoot(fixture, "nix/pkg/opaque-target");
    const declaration = {
      source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
      sha256: digest(sourceBytes),
      targets: [target],
    };
    await writeManifest(fixture, [
      { kind: "path", ...declaration },
      { kind: "spawn", ...declaration },
    ]);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.installRoots).toEqual([
      fixture.targetRoot,
      path.join(fixture.root, "nix/pkg/opaque-target"),
    ]);
  });

  test("admits a declared temporary root only while its source digest matches", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.targetRoot, "test", "gate.test.ts");
    const sourceBytes =
      'const modulePath = "../../../temporary/index.ts";\nawait import(modulePath);\n';
    await fs.writeFile(sourcePath, sourceBytes);
    const target = await addBunRoot(fixture, "nix/pkg/temporary");
    const declaration: ManagedGateOpaqueEdgeDeclaration = {
      kind: "dynamic",
      source: path.relative(fixture.root, sourcePath).split(path.sep).join("/"),
      sha256: digest(sourceBytes),
      targets: [target],
    };
    await writeManifest(fixture, [declaration]);

    const resolution = await resolveManagedGateClosure(fixture.root);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.installRoots).toEqual([
      fixture.targetRoot,
      path.join(fixture.root, "nix/pkg/temporary"),
    ]);

    await fs.appendFile(sourcePath, "export {};\n");
    const changed = await resolveManagedGateClosure(fixture.root);
    expect(changed.status).toBe("invalid");
    if (changed.status === "invalid") expect(changed.reason).toBe("source-digest-mismatch");
  });

  test("requires hashed declarations for reachable Nix commands and complete target roots", async () => {
    const scripts = { check: "bun run nix-check", "nix-check": "cd ../../.. && nix build .#cq" };
    const fixture = await createFixture(scripts);
    await writeManifest(fixture);
    const undeclared = await resolveManagedGateClosure(fixture.root);
    expect(undeclared.status).toBe("invalid");
    if (undeclared.status === "invalid") {
      expect(undeclared.reason).toBe("source-declaration-missing");
    }

    const packageBytes = await fs.readFile(path.join(fixture.root, TARGET_PACKAGE), "utf8");
    await writeManifest(fixture, [
      {
        kind: "nix",
        source: TARGET_PACKAGE,
        sha256: digest(packageBytes),
        targets: [],
      },
    ]);
    expect((await resolveManagedGateClosure(fixture.root)).status).toBe("resolved");

    await fs.rm(path.join(fixture.targetRoot, "bun.lock"));
    const incomplete = await resolveManagedGateClosure(fixture.root);
    expect(incomplete.status).toBe("invalid");
    if (incomplete.status === "invalid") expect(incomplete.reason).toBe("bun-root-incomplete");
  });
});
